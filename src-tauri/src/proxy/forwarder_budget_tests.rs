use super::tests::{
    claude_provider_at, codex_api_provider, send_codex, send_messages, spawn_flaky_upstream,
    test_forwarder,
};
use super::*;
use crate::provider::{ProviderMeta, ProviderRequestBudget};
use axum::http::HeaderMap;
use http::StatusCode;
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};

#[tokio::test]
async fn explicit_budget_preserves_stateful_codex_single_send() {
    let (base, hits, upstream) = spawn_flaky_upstream(usize::MAX).await;
    let mut provider = codex_api_provider("stateful", &base);
    provider
        .meta
        .get_or_insert_with(Default::default)
        .request_budget = Some(ProviderRequestBudget {
        first_byte_timeout_secs: Some(2),
        recovery_timeout_secs: Some(10),
        ..Default::default()
    });
    let fwd = test_forwarder(Duration::ZERO, Duration::ZERO).with_same_provider_retry(5, 1, 1);
    let result = send_codex(&fwd, json!({"model":"synthetic","stream":true,"previous_response_id":"synthetic-resource","input":"synthetic"}), vec![provider]).await;
    assert!(matches!(
        error(result),
        ProxyError::UpstreamError { status: 503, .. }
    ));
    assert_eq!(hits.load(Ordering::SeqCst), 1);
    upstream.abort();
}

#[tokio::test]
async fn cancel_during_recovery_drops_waits_and_never_sends_a_second_attempt() {
    let (base, hits, upstream) = spawn_flaky_upstream(usize::MAX).await;
    let fwd = Arc::new(
        test_forwarder(Duration::ZERO, Duration::ZERO).with_same_provider_retry(10, 5000, 5000),
    );
    let shared = fwd.clone();
    let provider = budget_provider(
        "cancel",
        &base,
        ProviderRequestBudget {
            recovery_timeout_secs: Some(10),
            ..Default::default()
        },
    );
    let task = tokio::spawn(async move { send_messages(&shared, vec![provider]).await });
    tokio::time::timeout(Duration::from_secs(2), async {
        while hits.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    task.abort();
    let _ = task.await;
    tokio::time::sleep(Duration::from_millis(40)).await;
    assert_eq!(hits.load(Ordering::SeqCst), 1);
    assert_eq!(fwd.status.read().await.active_connections, 0);
    upstream.abort();
}

#[tokio::test]
async fn actual_fallback_idle_budget_applies_after_output_without_replay() {
    use futures::TryStreamExt;
    let (bad, _, bad_task) = spawn_flaky_upstream(usize::MAX).await;
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = hits.clone();
    let (base, task) = serve(axum::Router::new().fallback(move || {
        counter.fetch_add(1, Ordering::SeqCst);
        async {
            let stream = async_stream::stream! {
                yield Ok::<_, std::io::Error>(Bytes::from_static(b"data: started\n\n"));
                tokio::time::sleep(Duration::from_millis(1600)).await;
                yield Ok(Bytes::from_static(b"data: late\n\n"));
            };
            axum::response::Response::builder()
                .header("content-type", "text/event-stream")
                .body(axum::body::Body::from_stream(stream))
                .unwrap()
        }
    }))
    .await;
    let mut fwd = test_forwarder(Duration::ZERO, Duration::ZERO);
    fwd.max_attempts = 2;
    let fallback = budget_provider(
        "idle",
        &base,
        ProviderRequestBudget {
            idle_timeout_secs: Some(1),
            ..Default::default()
        },
    );
    let result = fwd
        .forward_with_retry(
            &AppType::Claude,
            http::Method::POST,
            "/v1/messages",
            json!({"model":"synthetic","stream":true,"messages":[],"max_tokens":8}),
            HeaderMap::new(),
            Extensions::new(),
            vec![claude_provider_at("bad", &bad), fallback],
        )
        .await;
    let result = match result {
        Ok(result) => result,
        Err(error) => panic!("{}", error.error),
    };
    let timeout = super::super::request_budget::streaming(
        &result.provider,
        super::super::handler_context::StreamingTimeoutConfig {
            first_byte_timeout: 0,
            idle_timeout: 0,
        },
    );
    let stream = super::super::response_processor::create_logged_passthrough_stream(
        result.response.bytes_stream(),
        "synthetic",
        None,
        timeout,
        result.connection_guard,
    );
    let result: Result<Vec<Bytes>, _> = stream.try_collect().await;
    assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::TimedOut);
    assert_eq!(hits.load(Ordering::SeqCst), 1);
    task.abort();
    bad_task.abort();
}

fn budget_provider(id: &str, base: &str, settings: ProviderRequestBudget) -> Provider {
    let mut provider = claude_provider_at(id, base);
    provider.meta = Some(ProviderMeta {
        request_budget: Some(settings),
        ..Default::default()
    });
    provider
}

async fn serve(app: axum::Router) -> (String, tokio::task::JoinHandle<()>) {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (base, task)
}

fn error(result: Result<ForwardResult, ForwardError>) -> ProxyError {
    match result {
        Ok(_) => panic!("expected bounded failure"),
        Err(error) => error.error,
    }
}

#[tokio::test]
async fn provider_nonstream_budget_covers_headers_and_body_with_failover_disabled() {
    for late_body in [false, true] {
        let app = axum::Router::new().fallback(move || async move {
            if late_body {
                let stream = async_stream::stream! {
                    yield Ok::<_, std::io::Error>(Bytes::from_static(b"{"));
                    tokio::time::sleep(Duration::from_millis(1600)).await;
                    yield Ok(Bytes::from_static(b"}"));
                };
                axum::response::Response::new(axum::body::Body::from_stream(stream))
            } else {
                tokio::time::sleep(Duration::from_millis(1600)).await;
                axum::response::Response::new(axum::body::Body::from("{}"))
            }
        });
        let (base, task) = serve(app).await;
        let fwd = test_forwarder(Duration::ZERO, Duration::ZERO);
        let provider = budget_provider(
            "slow",
            &base,
            ProviderRequestBudget {
                non_streaming_timeout_secs: Some(1),
                ..Default::default()
            },
        );
        let started = std::time::Instant::now();
        assert!(matches!(
            error(send_messages(&fwd, vec![provider]).await),
            ProxyError::Timeout(_)
        ));
        assert!(started.elapsed() < Duration::from_secs(3));
        task.abort();
    }
}

#[tokio::test]
async fn provider_stream_first_byte_budget_covers_pooled_and_header_preserving_paths() {
    for format in ["anthropic", "openai_chat"] {
        let app = axum::Router::new().fallback(|| async {
            tokio::time::sleep(Duration::from_millis(1600)).await;
            "unused"
        });
        let (base, task) = serve(app).await;
        let mut provider = budget_provider(
            "slow",
            &base,
            ProviderRequestBudget {
                first_byte_timeout_secs: Some(1),
                ..Default::default()
            },
        );
        provider.meta.as_mut().unwrap().api_format = Some(format.into());
        let fwd = test_forwarder(Duration::ZERO, Duration::ZERO);
        let result = fwd
            .forward_with_retry(
                &AppType::Claude,
                http::Method::POST,
                "/v1/messages",
                json!({"model":"synthetic","stream":true,"messages":[],"max_tokens":8}),
                HeaderMap::new(),
                Extensions::new(),
                vec![provider],
            )
            .await;
        assert!(matches!(error(result), ProxyError::Timeout(_)));
        task.abort();
    }
}

#[tokio::test]
async fn recovery_deadline_stops_backoff_and_releases_waits_without_replaying() {
    let (base, hits, task) = spawn_flaky_upstream(usize::MAX).await;
    let fwd =
        test_forwarder(Duration::ZERO, Duration::ZERO).with_same_provider_retry(10, 5000, 5000);
    let provider = budget_provider(
        "flaky",
        &base,
        ProviderRequestBudget {
            recovery_timeout_secs: Some(1),
            ..Default::default()
        },
    );
    assert!(matches!(
        error(send_messages(&fwd, vec![provider]).await),
        ProxyError::RecoveryBudgetExceeded
    ));
    assert_eq!(hits.load(Ordering::SeqCst), 1);
    tokio::task::yield_now().await;
    assert_eq!(fwd.status.read().await.active_connections, 0);
    task.abort();
}

#[tokio::test]
async fn fallback_cannot_restart_total_budget_but_uses_its_own_timeout() {
    let (bad, _, bad_task) = spawn_flaky_upstream(usize::MAX).await;
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = hits.clone();
    let (slow, slow_task) = serve(axum::Router::new().fallback(move || {
        let counter = counter.clone();
        async move {
            counter.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(1600)).await;
            "{}"
        }
    }))
    .await;
    let mut fwd = test_forwarder(Duration::ZERO, Duration::ZERO);
    fwd.max_attempts = 2;
    let primary = budget_provider(
        "primary",
        &bad,
        ProviderRequestBudget {
            recovery_timeout_secs: Some(1),
            ..Default::default()
        },
    );
    let fallback = budget_provider(
        "fallback",
        &slow,
        ProviderRequestBudget {
            recovery_timeout_secs: Some(30),
            non_streaming_timeout_secs: Some(10),
            ..Default::default()
        },
    );
    assert!(matches!(
        error(send_messages(&fwd, vec![primary, fallback]).await),
        ProxyError::RecoveryBudgetExceeded
    ));
    assert_eq!(hits.load(Ordering::SeqCst), 1);
    bad_task.abort();
    slow_task.abort();
}

#[tokio::test]
async fn concurrent_cooldown_queue_deadlines_release_permits_and_wait_records() {
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = hits.clone();
    let (base, task) = serve(axum::Router::new().fallback(move || {
        counter.fetch_add(1, Ordering::SeqCst);
        async {
            (
                StatusCode::TOO_MANY_REQUESTS,
                [("retry-after", "3")],
                "synthetic",
            )
        }
    }))
    .await;
    let mut fwd = test_forwarder(Duration::ZERO, Duration::ZERO);
    fwd.rate_limit_retry_enabled = true;
    let provider = budget_provider(
        "limited",
        &base,
        ProviderRequestBudget {
            recovery_timeout_secs: Some(1),
            ..Default::default()
        },
    );
    let (left, right) = tokio::join!(
        send_messages(&fwd, vec![provider.clone()]),
        send_messages(&fwd, vec![provider.clone()])
    );
    assert!(matches!(error(left), ProxyError::RecoveryBudgetExceeded));
    assert!(matches!(error(right), ProxyError::RecoveryBudgetExceeded));
    assert_eq!(hits.load(Ordering::SeqCst), 2);
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(fwd.status.read().await.active_rate_limit_waits.is_empty());
    assert!(tokio::time::timeout(
        Duration::from_millis(100),
        fwd.router
            .acquire_rate_limit_recovery(&provider.id, "claude")
    )
    .await
    .is_ok());
    task.abort();
}

#[tokio::test]
async fn started_output_outlives_recovery_budget_without_replay() {
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = hits.clone();
    let (base, task) = serve(axum::Router::new().fallback(move || {
        counter.fetch_add(1, Ordering::SeqCst);
        async {
            let stream = async_stream::stream! {
                yield Ok::<_, std::io::Error>(Bytes::from_static(b"data: first\n\n"));
                tokio::time::sleep(Duration::from_millis(1200)).await;
                yield Ok(Bytes::from_static(b"data: done\n\n"));
            };
            axum::response::Response::builder()
                .header("content-type", "text/event-stream")
                .body(axum::body::Body::from_stream(stream))
                .unwrap()
        }
    }))
    .await;
    let provider = budget_provider(
        "stream",
        &base,
        ProviderRequestBudget {
            recovery_timeout_secs: Some(1),
            idle_timeout_secs: Some(3),
            ..Default::default()
        },
    );
    let fwd = test_forwarder(Duration::ZERO, Duration::ZERO).with_same_provider_retry(3, 1, 1);
    let result = fwd
        .forward_with_retry(
            &AppType::Claude,
            http::Method::POST,
            "/v1/messages",
            json!({"model":"synthetic","stream":true,"messages":[],"max_tokens":8}),
            HeaderMap::new(),
            Extensions::new(),
            vec![provider],
        )
        .await;
    let response = match result {
        Ok(result) => result.response,
        Err(error) => panic!("{}", error.error),
    };
    let bytes = response.bytes_with_limit(1024).await.unwrap();
    assert!(String::from_utf8_lossy(&bytes).contains("done"));
    assert_eq!(hits.load(Ordering::SeqCst), 1);
    task.abort();
}
