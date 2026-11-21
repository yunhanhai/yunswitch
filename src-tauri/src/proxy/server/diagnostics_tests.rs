use super::*;
use crate::provider::Provider;
use axum::{body::Body, http::StatusCode, response::IntoResponse, Json};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::time::{sleep, timeout, Duration};

const KEY: &str = "fake-diagnostics-key-private";
const INPUT: &str = "private-synthetic-prompt";
const ENCRYPTED: &str = "private-synthetic-encrypted";
const MODEL: &str = "private-synthetic-model";
const PROVIDER: &str = "private-synthetic-provider-id";
const LATE: &str = "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"synthetic output\"}\n\n";
const FAILED: &str = "event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\",\"error\":{\"code\":\"server_error\",\"message\":\"private-gateway-error\"}}}\n\n";

struct Fixture {
    proxy: ProxyServer,
    base: String,
    upstream: JoinHandle<()>,
}

impl Fixture {
    async fn start(
        router: Router,
        configure: impl FnOnce(&mut AppProxyConfig),
        backup: bool,
    ) -> Self {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let upstream_url = format!("http://{}", listener.local_addr().unwrap());
        let upstream = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let db = Arc::new(Database::memory().unwrap());
        let providers = [
            (PROVIDER, format!("{upstream_url}/primary/v1")),
            ("synthetic-backup", format!("{upstream_url}/backup/v1")),
        ];
        for (id, url) in providers.into_iter().take(if backup { 2 } else { 1 }) {
            let provider = Provider::with_id(
                id.into(),
                "private-synthetic-provider-name".into(),
                json!({"base_url":url,"auth":{"OPENAI_API_KEY":KEY}}),
                None,
            );
            db.save_provider("codex", &provider).unwrap();
            if backup {
                db.add_to_failover_queue("codex", id).unwrap();
            }
        }
        db.set_current_provider("codex", PROVIDER).unwrap();
        let mut config = db.get_proxy_config_for_app("codex").await.unwrap();
        configure(&mut config);
        db.update_proxy_config_for_app(config).await.unwrap();
        let proxy = ProxyServer::new(
            ProxyConfig {
                listen_port: 0,
                enable_logging: false,
                ..ProxyConfig::default()
            },
            db,
            None,
        );
        let info = proxy.start().await.unwrap();
        let base = format!("http://127.0.0.1:{}", info.port);
        Self {
            proxy,
            base,
            upstream,
        }
    }

    fn request(&self, input: &str) -> reqwest::RequestBuilder {
        reqwest::Client::builder().no_proxy().build().unwrap()
            .post(format!("{}/v1/responses", self.base))
            .bearer_auth("fake-synthetic-client-secret")
            .header("cookie", "fake-synthetic-cookie-secret")
            .json(&json!({
                "model": MODEL, "stream": true, "input": [{"type":"message","role":"user","content":input},
                {"type":"reasoning","id":"rs_private","encrypted_content":ENCRYPTED},
                {"type":"function_call","name":"synthetic","call_id":"call_private","arguments":"private-synthetic-tool-arguments"}]
            }))
    }

    fn snapshot(&self) -> Value {
        serde_json::to_value(self.proxy.diagnostics().snapshot()).unwrap()
    }

    fn detail(&self, id: &Value) -> Value {
        serde_json::to_value(self.proxy.diagnostics().detail(id.as_str().unwrap())).unwrap()
    }

    async fn until(&self, predicate: impl Fn(&Value) -> bool) -> Value {
        timeout(Duration::from_secs(4), async {
            loop {
                let state = self.snapshot();
                if predicate(&state) {
                    return state;
                }
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("did not see expected diagnostics: {}", self.snapshot()))
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.upstream.abort();
    }
}

#[tokio::test]
async fn concurrent_diagnostics_follow_shared_and_renewed_cooldowns() {
    let hits = Arc::new(AtomicUsize::new(0));
    let router = Router::new().fallback({
        let hits = hits.clone();
        move || {
            let hit = hits.fetch_add(1, Ordering::SeqCst);
            async move {
                match hit {
                    0 | 2 => (
                        StatusCode::TOO_MANY_REQUESTS,
                        [("retry-after", "1")],
                        "private-gateway-error",
                    )
                        .into_response(),
                    1 => (
                        StatusCode::TOO_MANY_REQUESTS,
                        [("retry-after", "2")],
                        "private-gateway-error",
                    )
                        .into_response(),
                    _ => Json(json!({"status":"completed","output":[]})).into_response(),
                }
            }
        }
    });
    let fixture = Fixture::start(
        router,
        |config| {
            config.auto_failover_enabled = false;
            config.rate_limit_retry_enabled = true;
            config.rate_limit_max_wait_secs = 5;
        },
        false,
    )
    .await;

    let first = tokio::spawn(fixture.request(INPUT).send());
    let state = fixture
        .until(|state| state["active"][0]["current"]["phase"] == "coolingDown")
        .await;
    let first_id = state["active"][0]["id"].clone();
    let second = tokio::spawn(fixture.request("second synthetic prompt").send());
    let both = fixture
        .until(|state| {
            let rows = state["active"].as_array().unwrap();
            rows.len() == 2
                && rows
                    .iter()
                    .any(|row| row["current"]["phase"] == "recoveryQueued")
        })
        .await;
    let second_id = both["active"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] != first_id)
        .unwrap()["id"]
        .clone();
    assert_ne!(first_id, second_id);
    let http_status = serde_json::to_value(fixture.proxy.get_status().await).unwrap();
    assert!(http_status.get("rateLimitWaitingRequests").is_none());
    let mut waits = fixture.proxy.rate_limit_waits_for_ui().await;
    timeout(Duration::from_secs(2), async {
        loop {
            waits = fixture.proxy.rate_limit_waits_for_ui().await;
            if waits.len() == 2 {
                break;
            }
            sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("both independent waits are visible to the desktop");
    for pending in [first, second] {
        let response = pending.await.unwrap().unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        response.bytes().await.unwrap();
    }
    assert_eq!(hits.load(Ordering::SeqCst), 5);
    let one = fixture.detail(&first_id);
    let two = fixture.detail(&second_id);
    assert_eq!(one["attempts"], 3);
    assert_eq!(two["attempts"], 2);
    assert_eq!(one["current"]["phase"], "succeeded");
    assert_eq!(two["current"]["phase"], "succeeded");
    let first_steps = one["steps"].as_array().unwrap();
    assert!(first_steps
        .iter()
        .any(|step| step["reason"] == "sharedCooldown"
            && step["plannedWaitMs"].as_u64().unwrap_or_default() > 0
            && step["elapsedMs"].as_u64().unwrap_or_default() > 0));
    assert!(
        first_steps
            .iter()
            .filter(|step| step["error"]["class"] == "rateLimited")
            .count()
            >= 2
    );
    assert!(two["steps"]
        .as_array()
        .unwrap()
        .iter()
        .any(|step| step["reason"] == "recoveryPermit"
            && step["elapsedMs"].as_u64().unwrap_or_default() > 0));
    assert!(fixture.snapshot()["active"].as_array().unwrap().is_empty());
    fixture.proxy.stop().await.unwrap();
}

#[tokio::test]
async fn diagnostics_distinguish_failover_output_failure_timeout_and_stop() {
    let primary_hits = Arc::new(AtomicUsize::new(0));
    let staged = Arc::new(tokio::sync::Notify::new());
    let router = Router::new().fallback({
        let primary_hits = primary_hits.clone();
        let staged = staged.clone();
        move |request: axum::extract::Request| {
            let primary_hits = primary_hits.clone();
            let staged = staged.clone();
            async move {
                let (parts, body) = request.into_parts();
                let path = parts.uri.path();
                assert_eq!(parts.headers["authorization"], format!("Bearer {KEY}"));
                let body = axum::body::to_bytes(body, 65536).await.unwrap();
                let parsed: Value = serde_json::from_slice(&body).unwrap();
                match parsed["input"][0]["content"].as_str().unwrap() {
                    "headers-timeout" | "stop-during-send" => {
                        std::future::pending::<()>().await;
                        unreachable!()
                    }
                    _ if path.starts_with("/primary/") => {
                        primary_hits.fetch_add(1, Ordering::SeqCst);
                        (StatusCode::SERVICE_UNAVAILABLE, "private-gateway-error").into_response()
                    }
                    _ => {
                        let stream = async_stream::stream! {
                            yield Ok::<_, std::io::Error>(bytes::Bytes::from_static(LATE.as_bytes()));
                            staged.notified().await;
                            yield Ok(bytes::Bytes::from_static(FAILED.as_bytes()));
                        };
                        ([("content-type", "text/event-stream")], Body::from_stream(stream)).into_response()
                    }
                }
            }
        }
    });
    let fixture = Fixture::start(
        router,
        |config| {
            config.auto_failover_enabled = true;
            config.max_retries = 1;
            config.same_provider_retries = 1;
            config.same_provider_retry_backoff_ms = 20;
            config.same_provider_retry_max_backoff_ms = 20;
            config.streaming_first_byte_timeout = 1;
            config.circuit_failure_threshold = 10;
        },
        true,
    )
    .await;

    let response = fixture.request(INPUT).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let output = fixture
        .until(|state| state["active"][0]["current"]["phase"] == "streaming")
        .await;
    let id = output["active"][0]["id"].clone();
    staged.notify_one();
    assert!(response.text().await.unwrap().contains("response.failed"));
    let done = fixture
        .until(|state| state["recent"][0]["current"]["phase"] == "failed")
        .await;
    assert_eq!(done["recent"][0]["id"], id);
    let detail = fixture.detail(&id);
    let steps = detail["steps"].as_array().unwrap();
    assert_eq!(detail["attempts"], 3);
    assert_eq!(primary_hits.load(Ordering::SeqCst), 2);
    assert!(steps.iter().any(|step| step["phase"] == "retrying"
        && step["plannedWaitMs"].as_u64().unwrap_or_default() > 0));
    assert!(steps.iter().any(
        |step| step["phase"] == "failingOver" && step["providerRef"] != steps[0]["providerRef"]
    ));
    let text = format!("{detail} {done}");
    for secret in [
        KEY,
        INPUT,
        ENCRYPTED,
        MODEL,
        PROVIDER,
        "private-synthetic-provider-name",
        "private-synthetic-tool-arguments",
        "fake-synthetic-client-secret",
        "fake-synthetic-cookie-secret",
        "private-gateway-error",
        "rs_private",
        "call_private",
        "synthetic output",
    ] {
        assert!(!text.contains(secret), "diagnostics contain {secret}");
    }
    let wire_status = reqwest::get(format!("{}/status", fixture.base))
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(!wire_status.contains(id.as_str().unwrap()));
    assert!(!wire_status.contains("private-gateway-error"));

    let timed = fixture.request("headers-timeout").send().await.unwrap();
    assert_eq!(timed.status(), StatusCode::GATEWAY_TIMEOUT);
    assert_eq!(
        fixture.snapshot()["recent"][0]["current"]["phase"],
        "timedOut"
    );

    let pending = tokio::spawn(fixture.request("stop-during-send").send());
    let state = fixture
        .until(|state| state["active"][0]["attempts"] == 1)
        .await;
    fixture.proxy.stop().await.unwrap();
    assert!(pending.await.unwrap().is_err());
    assert!(fixture.snapshot()["active"].as_array().unwrap().is_empty());
    let stopped = fixture.detail(&state["active"][0]["id"]);
    assert_eq!(stopped["current"]["phase"], "cancelled");
    assert_eq!(stopped["current"]["reason"], "proxyStopped");
}
