//! Bounded request lifecycles for desktop IPC. The registry never owns request
//! or response content, credentials, session identifiers, or error messages.

mod response;

use super::ProxyError;
use axum::extract::Request;
use axum::response::Response;
use serde::Serialize;
use std::{
    collections::{hash_map::RandomState, HashMap, VecDeque},
    future::Future,
    hash::BuildHasher,
    sync::{Arc, Mutex, MutexGuard, OnceLock},
    time::Duration,
};
use tokio::time::Instant;

const MAX_ACTIVE: usize = 128;
const MAX_RECENT: usize = 64;
const MAX_STEPS: usize = 48;
const RETENTION: Duration = Duration::from_secs(15 * 60);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Phase {
    Sending,
    CoolingDown,
    RecoveryQueued,
    Retrying,
    FailingOver,
    Streaming,
    Succeeded,
    Failed,
    Cancelled,
    TimedOut,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Reason {
    RetryAfter,
    RateLimitBackoff,
    SharedCooldown,
    RecoveryPermit,
    RateLimitRecovery,
    TransientBackoff,
    RequestCorrection,
    ProxyStopped,
    ClientDisconnected,
    UpstreamCancelled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ErrorClass {
    RateLimited,
    Billing,
    Authentication,
    Permission,
    InvalidRequest,
    NoProvider,
    Network,
    Timeout,
    Upstream,
    ResponseTooLarge,
    ResponseInterrupted,
    Incomplete,
    RecoveryWaitLimit,
    Internal,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiagnosticError {
    class: ErrorClass,
    #[serde(skip_serializing_if = "Option::is_none")]
    http_status: Option<u16>,
}

impl DiagnosticError {
    pub(crate) const fn new(class: ErrorClass) -> Self {
        Self {
            class,
            http_status: None,
        }
    }

    pub(crate) const fn http(status: u16) -> Self {
        let class = match status {
            401 => ErrorClass::Authentication,
            403 => ErrorClass::Permission,
            408 | 504 => ErrorClass::Timeout,
            413 => ErrorClass::ResponseTooLarge,
            429 => ErrorClass::RateLimited,
            400..=499 => ErrorClass::InvalidRequest,
            _ => ErrorClass::Upstream,
        };
        Self {
            class,
            http_status: Some(status),
        }
    }

    fn phase(self) -> Phase {
        if self.class == ErrorClass::Timeout {
            Phase::TimedOut
        } else {
            Phase::Failed
        }
    }
}

impl From<&ProxyError> for DiagnosticError {
    fn from(error: &ProxyError) -> Self {
        use ProxyError::*;
        Self::new(match error {
            UpstreamError { status, .. } => return Self::http(*status),
            RateLimited { .. } => return Self::http(429),
            BillingExhausted(_) => ErrorClass::Billing,
            Timeout(_) | StreamIdleTimeout(_) => ErrorClass::Timeout,
            AuthError(_) => ErrorClass::Authentication,
            ForwardFailed(_) => ErrorClass::Network,
            NoAvailableProvider
            | AllProvidersCircuitOpen
            | NoProvidersConfigured
            | MaxRetriesExceeded
            | ProviderUnhealthy(_) => ErrorClass::NoProvider,
            InvalidRequest(_) | ConfigError(_) => ErrorClass::InvalidRequest,
            ResponseBodyTooLarge(_) => ErrorClass::ResponseTooLarge,
            _ => ErrorClass::Internal,
        })
    }
}

impl std::fmt::Display for DiagnosticError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self.class)?;
        if let Some(status) = self.http_status {
            write!(f, " (HTTP {status})")?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Step {
    phase: Phase,
    attempt: u32,
    offset_ms: u64,
    elapsed_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<Reason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    planned_wait_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    wait_limit_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<DiagnosticError>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Summary {
    id: String,
    app_type: String,
    started_at_ms: i64,
    elapsed_ms: u64,
    attempts: u32,
    current: Step,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Detail {
    #[serde(flatten)]
    summary: Summary,
    steps: Vec<Step>,
    omitted_steps: u64,
}

impl Detail {
    pub(crate) fn app_type(&self) -> &str {
        &self.summary.app_type
    }

    pub(crate) fn contains_provider(&self, reference: &str) -> bool {
        self.steps
            .iter()
            .any(|step| step.provider_ref.as_deref() == Some(reference))
    }
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    active: Vec<Summary>,
    recent: Vec<Summary>,
    untracked_active: usize,
}

struct Record {
    id: String,
    app_type: String,
    started: Instant,
    started_at_ms: i64,
    attempts: u32,
    steps: VecDeque<Step>,
    omitted_steps: u64,
    ended: Option<Instant>,
}

fn ms(duration: Duration) -> u64 {
    duration.as_millis().try_into().unwrap_or(u64::MAX)
}

fn fingerprint(namespace: &str, app: &str, value: &str) -> u64 {
    // Keyed for this process. Arbitrary identifiers can contain secrets, even
    // if they look like valid provider IDs or model names.
    static KEY: OnceLock<RandomState> = OnceLock::new();
    KEY.get_or_init(RandomState::new)
        .hash_one((namespace, app, value))
}

pub(crate) fn provider_ref(app: &str, id: &str) -> String {
    format!("p-{:016x}", fingerprint("provider", app, id))
}

fn model_ref(app: &str, model: &str) -> String {
    match model {
        // Exact public identifiers only. User-defined aliases and arbitrary
        // upstream model names must never be serialized as text.
        "gpt-5"
        | "gpt-5-mini"
        | "gpt-5.1"
        | "gpt-5.1-codex"
        | "gpt-5.2"
        | "gpt-5.2-codex"
        | "gpt-5.3-codex"
        | "gpt-5.4"
        | "gpt-5.4-mini"
        | "gpt-5.5"
        | "claude-opus-4-6"
        | "claude-sonnet-4-6"
        | "claude-haiku-4-5"
        | "gemini-2.5-pro"
        | "gemini-2.5-flash"
        | "gemini-3-pro-preview"
        | "gemini-3-flash-preview" => model.to_owned(),
        _ => format!("m-{:016x}", fingerprint("model", app, model)),
    }
}

impl Record {
    fn current(&mut self) -> &mut Step {
        self.steps.back_mut().expect("request has an initial step")
    }

    fn advance(&mut self, phase: Phase, reason: Option<Reason>) -> &mut Step {
        let offset = ms(self.started.elapsed());
        let current = self.current();
        current.elapsed_ms = offset.saturating_sub(current.offset_ms);
        let provider_ref = current.provider_ref.clone();
        let model = current.model.clone();
        if self.steps.len() >= MAX_STEPS {
            // Keep the start and the latest steps, including the outcome.
            self.steps.remove(1);
            self.omitted_steps += 1;
        }
        self.steps.push_back(Step {
            phase,
            attempt: self.attempts,
            offset_ms: offset,
            elapsed_ms: 0,
            provider_ref,
            model,
            reason,
            planned_wait_ms: None,
            wait_limit_ms: None,
            error: None,
        });
        self.current()
    }

    fn summary(&self) -> Summary {
        let elapsed_ms = ms(self.ended.unwrap_or_else(Instant::now) - self.started);
        let mut current = self.steps.back().expect("initial step").clone();
        if self.ended.is_none() {
            current.elapsed_ms = elapsed_ms.saturating_sub(current.offset_ms);
        }
        Summary {
            id: self.id.clone(),
            app_type: self.app_type.clone(),
            started_at_ms: self.started_at_ms,
            elapsed_ms,
            attempts: self.attempts,
            current,
        }
    }

    fn detail(&self) -> Detail {
        let summary = self.summary();
        let mut steps: Vec<_> = self.steps.iter().cloned().collect();
        if let Some(last) = steps.last_mut() {
            *last = summary.current.clone();
        }
        Detail {
            summary,
            steps,
            omitted_steps: self.omitted_steps,
        }
    }
}

#[derive(Default)]
struct Registry {
    accepting: bool,
    active: HashMap<String, Record>,
    recent: VecDeque<Record>,
    untracked_active: usize,
}

impl Registry {
    fn prune(&mut self) {
        self.prune_at(Instant::now());
    }

    fn prune_at(&mut self, now: Instant) {
        self.recent.retain(|row| {
            row.ended
                .is_some_and(|ended| now.duration_since(ended) < RETENTION)
        });
    }

    fn archive(&mut self, mut record: Record, outcome: Outcome) {
        let (phase, reason, error) = match outcome {
            Outcome::Success => (Phase::Succeeded, None, None),
            Outcome::Error(error) => (error.phase(), None, Some(error)),
            Outcome::Cancelled(reason) => (Phase::Cancelled, Some(reason), None),
        };
        record.advance(phase, reason).error = error;
        record.ended = Some(Instant::now());
        if self.recent.len() == MAX_RECENT {
            self.recent.pop_back();
        }
        self.recent.push_front(record);
    }
}

#[derive(Default)]
pub(crate) struct Diagnostics {
    registry: Mutex<Registry>,
    reaper: OnceLock<tokio::task::AbortHandle>,
}

impl Diagnostics {
    fn lock(&self) -> MutexGuard<'_, Registry> {
        self.registry
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub(crate) fn start(self: &Arc<Self>) {
        self.lock().accepting = true;
        self.reaper.get_or_init(|| {
            let store = Arc::downgrade(self);
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_secs(30)).await;
                    let Some(store) = store.upgrade() else { break };
                    store.lock().prune();
                }
            })
            .abort_handle()
        });
    }

    pub(crate) fn stop(&self) {
        let mut registry = self.lock();
        registry.accepting = false;
        registry.untracked_active = 0;
        let mut active: Vec<_> = registry
            .active
            .drain()
            .map(|(_, request)| request)
            .collect();
        active.sort_unstable_by_key(|request| request.started);
        for record in active {
            registry.archive(record, Outcome::Cancelled(Reason::ProxyStopped));
        }
        registry.prune();
    }

    fn begin(self: &Arc<Self>, app_type: &str) -> Option<RequestGuard> {
        let mut registry = self.lock();
        if !registry.accepting {
            return None;
        }
        registry.prune();
        let trace = if registry.active.len() < MAX_ACTIVE {
            let id = uuid::Uuid::new_v4().simple().to_string();
            let started = Instant::now();
            let record = Record {
                id: id.clone(),
                app_type: app_type.to_owned(),
                started,
                started_at_ms: chrono::Utc::now().timestamp_millis(),
                attempts: 0,
                steps: VecDeque::from([Step {
                    phase: Phase::Sending,
                    attempt: 0,
                    offset_ms: 0,
                    elapsed_ms: 0,
                    provider_ref: None,
                    model: None,
                    reason: None,
                    planned_wait_ms: None,
                    wait_limit_ms: None,
                    error: None,
                }]),
                omitted_steps: 0,
                ended: None,
            };
            registry.active.insert(id.clone(), record);
            Some(RequestTrace {
                store: self.clone(),
                id,
            })
        } else {
            registry.untracked_active = registry.untracked_active.saturating_add(1);
            None
        };
        Some(RequestGuard {
            store: self.clone(),
            trace,
            armed: true,
        })
    }

    pub(crate) fn snapshot(&self) -> Snapshot {
        let mut registry = self.lock();
        registry.prune();
        let mut active: Vec<_> = registry.active.values().map(Record::summary).collect();
        active.sort_unstable_by(|a, b| b.started_at_ms.cmp(&a.started_at_ms).then(a.id.cmp(&b.id)));
        Snapshot {
            active,
            recent: registry.recent.iter().map(Record::summary).collect(),
            untracked_active: registry.untracked_active,
        }
    }

    pub(crate) fn detail(&self, id: &str) -> Option<Detail> {
        let mut registry = self.lock();
        registry.prune();
        registry
            .active
            .get(id)
            .or_else(|| registry.recent.iter().find(|record| record.id == id))
            .map(Record::detail)
    }
}

impl Drop for Diagnostics {
    fn drop(&mut self) {
        if let Some(reaper) = self.reaper.get() {
            reaper.abort();
        }
    }
}

#[derive(Clone)]
pub(crate) struct RequestTrace {
    store: Arc<Diagnostics>,
    id: String,
}

impl RequestTrace {
    fn update(&self, edit: impl FnOnce(&mut Record)) {
        if let Some(record) = self.store.lock().active.get_mut(&self.id) {
            edit(record);
        }
    }

    pub(crate) fn provider(&self, id: &str, failover: bool) {
        self.update(|record| {
            let reference = provider_ref(&record.app_type, id);
            let phase = if failover {
                Phase::FailingOver
            } else {
                Phase::Sending
            };
            let current = if failover {
                record.advance(phase, None)
            } else {
                record.current()
            };
            current.provider_ref = Some(reference);
            current.model = None;
        });
    }

    pub(crate) fn send(&self, model: Option<&str>) {
        self.update(|record| {
            let model = model
                .filter(|model| !model.is_empty() && *model != "unknown")
                .map(|model| model_ref(&record.app_type, model));
            let (phase, reason, followed_wait) = {
                let current = record.current();
                (
                    current.phase,
                    current.reason,
                    current.planned_wait_ms.is_some(),
                )
            };
            record.attempts = record.attempts.saturating_add(1);
            let attempt = record.attempts;
            let current = if followed_wait {
                record.advance(phase, reason)
            } else {
                record.current()
            };
            current.attempt = attempt;
            current.model = model;
        });
    }

    pub(crate) fn step(
        &self,
        phase: Phase,
        reason: Reason,
        planned_wait_ms: Option<u64>,
        wait_limit_ms: Option<u64>,
    ) {
        self.update(|record| {
            let step = record.advance(phase, Some(reason));
            step.planned_wait_ms = planned_wait_ms;
            step.wait_limit_ms = wait_limit_ms;
        });
    }

    pub(crate) fn note_error(&self, error: DiagnosticError) {
        self.update(|record| record.current().error = Some(error));
    }

    fn streaming(&self) {
        self.update(|record| {
            record.advance(Phase::Streaming, None);
        });
    }
}

#[derive(Clone, Copy)]
enum Outcome {
    Success,
    Error(DiagnosticError),
    Cancelled(Reason),
}

struct RequestGuard {
    store: Arc<Diagnostics>,
    trace: Option<RequestTrace>,
    armed: bool,
}

impl RequestGuard {
    fn finish(&mut self, outcome: Outcome) {
        if !std::mem::replace(&mut self.armed, false) {
            return;
        }
        let mut registry = self.store.lock();
        if let Some(trace) = self.trace.take() {
            if let Some(record) = registry.active.remove(&trace.id) {
                registry.archive(record, outcome);
                registry.prune();
            }
        } else {
            registry.untracked_active = registry.untracked_active.saturating_sub(1);
        }
    }
}

impl Drop for RequestGuard {
    fn drop(&mut self) {
        self.finish(Outcome::Cancelled(Reason::ClientDisconnected));
    }
}

/// Own the diagnostics lease through request parsing, routing and delivery.
/// Only the desktop command surfaces the record. Nothing is added to HTTP.
pub(crate) async fn track<F>(
    store: Arc<Diagnostics>,
    app_type: &str,
    mut request: Request,
    handle: impl FnOnce(Request) -> F,
) -> Result<Response, ProxyError>
where
    F: Future<Output = Result<Response, ProxyError>>,
{
    let Some(mut guard) = store.begin(app_type) else {
        return handle(request).await;
    };
    if let Some(trace) = &guard.trace {
        request.extensions_mut().insert(trace.clone());
    }
    let head = request.method() == http::Method::HEAD;
    match handle(request).await {
        Ok(response) => Ok(response::observe(response, guard, head)),
        Err(error) => {
            guard.finish(Outcome::Error((&error).into()));
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn history_expiration_and_capacity_never_evict_other_live_requests() {
        let store = Arc::new(Diagnostics::default());
        store.start();
        let mut live: Vec<_> = (0..MAX_ACTIVE)
            .map(|_| store.begin("codex").unwrap())
            .collect();
        let kept = live[0].trace.as_ref().unwrap().id.clone();
        let overflow = store.begin("claude").unwrap();
        let before = store.snapshot();
        assert_eq!(before.active.len(), MAX_ACTIVE);
        assert_eq!(before.untracked_active, 1);
        drop(overflow);
        assert_eq!(store.snapshot().untracked_active, 0);

        let discarded = live[1].trace.as_ref().unwrap().id.clone();
        for request in live.drain(1..) {
            drop(request);
        }
        assert_eq!(store.snapshot().recent.len(), MAX_RECENT);
        assert!(store.detail(&discarded).is_none());
        assert!(store.detail(&kept).is_some());

        let expired = {
            let mut registry = store.lock();
            let ended = Instant::now();
            let id = {
                let record = registry.recent.front_mut().unwrap();
                record.ended = Some(ended);
                record.id.clone()
            };
            registry.prune_at(ended + RETENTION + Duration::from_secs(1));
            id
        };
        assert!(store
            .lock()
            .recent
            .iter()
            .all(|record| record.id != expired));

        store.stop();
        assert!(store.snapshot().active.is_empty());
        drop(live);
        let stopped = store.detail(&kept).unwrap();
        assert_eq!(stopped.summary.current.phase, Phase::Cancelled);
        assert_eq!(stopped.summary.current.reason, Some(Reason::ProxyStopped));
        assert!(store.begin("codex").is_none());
    }

    #[tokio::test]
    async fn timelines_only_retain_bounded_steps_and_safe_fields() {
        let store = Arc::new(Diagnostics::default());
        store.start();
        let mut request = store.begin("codex").unwrap();
        let trace = request.trace.as_ref().unwrap();
        let id = trace.id.clone();
        for _ in 0..MAX_STEPS + 5 {
            trace.provider("fake-key-in-provider-id", false);
            trace.send(Some("private-model-value"));
            trace.step(Phase::Retrying, Reason::TransientBackoff, Some(20), None);
        }
        request.finish(Outcome::Error(
            (&ProxyError::UpstreamError {
                status: 503,
                body: Some("private upstream error and session text".into()),
            })
                .into(),
        ));
        let row = store.detail(&id).unwrap();
        assert_eq!(row.steps.len(), MAX_STEPS);
        assert!(row.omitted_steps > 0);
        assert_eq!(row.steps[0].phase, Phase::Sending);
        assert_eq!(row.summary.current.phase, Phase::Failed);
        assert_eq!(row.summary.current.error, Some(DiagnosticError::http(503)));
        let json = serde_json::to_string(&row).unwrap();
        for private in [
            "fake-key-in-provider-id",
            "private-model-value",
            "private upstream error",
        ] {
            assert!(!json.contains(private));
        }
    }
}
