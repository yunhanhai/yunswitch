//! Per-provider overrides and one monotonic, output-before deadline per request.
use super::{handler_context::StreamingTimeoutConfig, ProxyError};
use crate::provider::Provider;
use std::{
    future::Future,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{sync::Notify, time::Instant};

pub(crate) fn overrides(provider: &Provider) -> Option<&crate::provider::ProviderRequestBudget> {
    provider.meta.as_ref()?.request_budget.as_ref()
}

// Imported data can bypass provider-save validation. Keep positive values bounded.
pub(crate) fn seconds(value: Option<u32>) -> Option<u64> {
    value
        .filter(|value| *value > 0)
        .map(|value| u64::from(value.min(3600)))
}

pub(crate) fn streaming(
    provider: &Provider,
    inherited: StreamingTimeoutConfig,
) -> StreamingTimeoutConfig {
    let budget = overrides(provider);
    StreamingTimeoutConfig {
        first_byte_timeout: seconds(budget.and_then(|value| value.first_byte_timeout_secs))
            .unwrap_or(inherited.first_byte_timeout),
        idle_timeout: seconds(budget.and_then(|value| value.idle_timeout_secs))
            .unwrap_or(inherited.idle_timeout),
    }
}

#[derive(Clone)]
pub(crate) struct RecoveryBudget(Arc<RecoveryState>);

struct RecoveryState {
    started: Instant,
    deadline: Mutex<Option<Instant>>,
    changed: Notify,
}

impl RecoveryBudget {
    pub(crate) fn new() -> Self {
        Self(Arc::new(RecoveryState {
            started: Instant::now(),
            deadline: Mutex::new(None),
            changed: Notify::new(),
        }))
    }

    /// A fallback can tighten the request budget, never reset or extend it.
    pub(crate) fn constrain(&self, provider: &Provider) {
        let Some(seconds) =
            seconds(overrides(provider).and_then(|value| value.recovery_timeout_secs))
        else {
            return;
        };
        let candidate = self.0.started + Duration::from_secs(seconds);
        let mut deadline = self.0.deadline.lock().unwrap_or_else(|e| e.into_inner());
        if deadline.is_none_or(|current| candidate < current) {
            *deadline = Some(candidate);
            self.0.changed.notify_one();
        }
    }

    pub(crate) fn remaining_ms(&self) -> Option<u64> {
        self.deadline().map(|deadline| {
            deadline
                .saturating_duration_since(Instant::now())
                .as_millis() as u64
        })
    }

    fn deadline(&self) -> Option<Instant> {
        *self.0.deadline.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(crate) fn check(&self) -> Result<(), ProxyError> {
        if self
            .deadline()
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            Err(ProxyError::RecoveryBudgetExceeded)
        } else {
            Ok(())
        }
    }

    async fn expired(&self) {
        loop {
            let changed = self.0.changed.notified();
            let deadline = self.deadline();
            match deadline {
                Some(deadline) => tokio::select! {
                    biased;
                    _ = tokio::time::sleep_until(deadline) => return,
                    _ = changed => {},
                },
                None => changed.await,
            }
        }
    }

    pub(crate) async fn run<T>(&self, future: impl Future<Output = T>) -> Result<T, ProxyError> {
        tokio::select! {
            biased;
            _ = self.expired() => Err(ProxyError::RecoveryBudgetExceeded),
            value = future => Ok(value),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::{ProviderMeta, ProviderRequestBudget};

    fn provider(recovery: u32) -> Provider {
        let mut provider =
            Provider::with_id("test".into(), "test".into(), serde_json::json!({}), None);
        provider.meta = Some(ProviderMeta {
            request_budget: Some(ProviderRequestBudget {
                recovery_timeout_secs: Some(recovery),
                ..Default::default()
            }),
            ..Default::default()
        });
        provider
    }

    #[test]
    fn absent_and_invalid_imports_cannot_disable_inherited_timeouts() {
        let mut provider = provider(1);
        provider
            .meta
            .as_mut()
            .unwrap()
            .request_budget
            .as_mut()
            .unwrap()
            .idle_timeout_secs = Some(0);
        let inherited = StreamingTimeoutConfig {
            first_byte_timeout: 7,
            idle_timeout: 11,
        };
        let actual = streaming(&provider, inherited);
        assert_eq!((actual.first_byte_timeout, actual.idle_timeout), (7, 11));
        assert_eq!(seconds(Some(u32::MAX)), Some(3600));
        assert!(provider
            .meta
            .as_ref()
            .unwrap()
            .request_budget
            .as_ref()
            .unwrap()
            .validate()
            .is_err());
        let legacy: ProviderMeta = serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(legacy.request_budget.is_none());
    }

    #[tokio::test]
    async fn fallback_never_resets_deadline_and_concurrent_requests_are_independent() {
        let first = RecoveryBudget::new();
        let second = RecoveryBudget::new();
        first.constrain(&provider(2));
        let original = first.deadline().unwrap();
        first.constrain(&provider(30));
        assert_eq!(first.deadline(), Some(original));
        first.constrain(&provider(1));
        assert!(first.deadline().unwrap() < original);
        assert!(second.deadline().is_none());
        first.0.deadline.lock().unwrap().replace(Instant::now());
        assert!(matches!(
            first.run(std::future::pending::<()>()).await,
            Err(ProxyError::RecoveryBudgetExceeded)
        ));
        assert_eq!(second.run(async { 42 }).await.unwrap(), 42);
    }

    #[tokio::test]
    async fn activating_budget_wakes_an_already_pending_request() {
        let budget = RecoveryBudget::new();
        let watching = budget.clone();
        let task = tokio::spawn(async move { watching.run(std::future::pending::<()>()).await });
        tokio::task::yield_now().await;
        budget.constrain(&provider(1));
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(3), task)
                .await
                .unwrap()
                .unwrap(),
            Err(ProxyError::RecoveryBudgetExceeded)
        ));
    }
}
