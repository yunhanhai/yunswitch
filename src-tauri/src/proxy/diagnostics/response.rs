use super::{DiagnosticError, ErrorClass, Outcome, Reason, RequestGuard};
use axum::{
    body::{Body, Bytes},
    response::Response,
};
use http::header::{CONTENT_ENCODING, CONTENT_TYPE};
use http_body::{Body as HttpBody, Frame, SizeHint};
use serde_json::Value;
use std::{
    error::Error,
    pin::Pin,
    task::{Context, Poll},
};

pub(super) fn observe(mut response: Response, mut guard: RequestGuard, head: bool) -> Response {
    if !response.status().is_success() {
        let error = response
            .extensions_mut()
            .remove::<DiagnosticError>()
            .unwrap_or_else(|| DiagnosticError::http(response.status().as_u16()));
        guard.finish(Outcome::Error(error));
        return response;
    }
    if head || response.body().is_end_stream() {
        guard.finish(Outcome::Success);
        return response;
    }

    let sse = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .split(';')
                .next()
                .is_some_and(|media| media.trim().eq_ignore_ascii_case("text/event-stream"))
        });
    let plain = response
        .headers()
        .get(CONTENT_ENCODING)
        .is_none_or(|value| value.as_bytes().eq_ignore_ascii_case(b"identity"));
    let (parts, body) = response.into_parts();
    Response::from_parts(
        parts,
        Body::new(ObservedBody {
            body,
            inspect: (sse && plain && guard.trace.is_some()).then(SseInspection::default),
            guard,
            sse,
            emitted: false,
            terminal: None,
        }),
    )
}

struct ObservedBody {
    body: Body,
    guard: RequestGuard,
    inspect: Option<SseInspection>,
    sse: bool,
    emitted: bool,
    terminal: Option<Outcome>,
}

impl HttpBody for ObservedBody {
    type Data = Bytes;
    type Error = axum::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        let this = &mut *self;
        let result = Pin::new(&mut this.body).poll_frame(cx);
        match &result {
            Poll::Ready(Some(Ok(frame))) => {
                if let Some(bytes) = frame.data_ref().filter(|bytes| !bytes.is_empty()) {
                    if this.sse && !this.emitted {
                        this.emitted = true;
                        if let Some(trace) = &this.guard.trace {
                            trace.streaming();
                        }
                    }
                    if let Some(inspect) = &mut this.inspect {
                        if let Some(outcome) = inspect.feed(bytes) {
                            this.terminal = Some(outcome);
                            this.inspect = None;
                        }
                    }
                }
                if this.body.is_end_stream() {
                    this.guard.finish(this.terminal.unwrap_or(Outcome::Success));
                }
            }
            Poll::Ready(Some(Err(error))) => {
                let outcome = this
                    .terminal
                    .unwrap_or_else(|| Outcome::Error(stream_error(error)));
                this.guard.finish(outcome);
            }
            Poll::Ready(None) => {
                this.guard.finish(this.terminal.unwrap_or(Outcome::Success));
            }
            Poll::Pending => {}
        }
        result
    }

    fn is_end_stream(&self) -> bool {
        self.body.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.body.size_hint()
    }
}

impl Drop for ObservedBody {
    fn drop(&mut self) {
        // An explicit protocol terminal event stays meaningful if the client
        // closes immediately after receiving it. Otherwise Drop is cancellation.
        if let Some(outcome) = self.terminal {
            self.guard.finish(outcome);
        }
    }
}

fn stream_error(error: &(dyn Error + 'static)) -> DiagnosticError {
    let mut cause = Some(error);
    while let Some(error) = cause {
        if error
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::TimedOut)
            || error
                .downcast_ref::<reqwest::Error>()
                .is_some_and(reqwest::Error::is_timeout)
        {
            return DiagnosticError::new(ErrorClass::Timeout);
        }
        cause = error.source();
    }
    DiagnosticError::new(ErrorClass::ResponseInterrupted)
}

// This scratch space exists only while forwarding an SSE body. An oversized
// event is skipped up to the next blank line. No bytes reach the registry.
const MAX_EVENT_BYTES: usize = 64 * 1024;

#[derive(Default)]
struct SseInspection {
    event: Vec<u8>,
    line_has_content: bool,
    oversized: bool,
}

impl SseInspection {
    fn feed(&mut self, bytes: &[u8]) -> Option<Outcome> {
        for part in bytes.split_inclusive(|b| *b == b'\n') {
            let end = part.last() == Some(&b'\n');
            let line_content = if end { &part[..part.len() - 1] } else { part };
            self.line_has_content |= line_content.iter().any(|b| *b != b'\r');
            if end && !self.line_has_content {
                let outcome = if self.oversized {
                    None
                } else {
                    inspect_event(&self.event)
                };
                self.event.clear();
                self.oversized = false;
                if outcome.is_some() {
                    return outcome;
                }
            } else if !self.oversized {
                if self.event.len() + part.len() <= MAX_EVENT_BYTES {
                    self.event.extend_from_slice(part);
                } else {
                    self.event.clear();
                    self.oversized = true;
                }
            }
            if end {
                self.line_has_content = false;
            }
        }
        None
    }
}

fn inspect_event(bytes: &[u8]) -> Option<Outcome> {
    let block = std::str::from_utf8(bytes).ok()?;
    if block.starts_with(':') && !block.contains('\n') {
        return None;
    }
    let mut event = "";
    let mut data = None;
    let mut multiline = String::new();
    for line in block.trim_start_matches('\u{feff}').lines() {
        if let Some(name) = line.strip_prefix("event:") {
            event = name.trim();
        }
        if let Some(value) = line.strip_prefix("data:") {
            if let Some(first) = data {
                if multiline.is_empty() {
                    multiline.push_str(first);
                }
                multiline.push('\n');
                multiline.push_str(value);
            } else {
                data = Some(value);
            }
        }
    }
    // Parse only properties that can describe a terminal event. Large text,
    // tool parameters, and other fields are skipped by the deserializer.
    #[derive(serde::Deserialize, Default)]
    struct Event {
        #[serde(rename = "type", default)]
        kind: String,
        #[serde(default)]
        error: Option<Value>,
        #[serde(default)]
        response: Option<TerminalResponse>,
        #[serde(default)]
        code: Option<String>,
    }

    #[derive(serde::Deserialize)]
    struct TerminalResponse {
        #[serde(default)]
        status: Option<String>,
        #[serde(default)]
        error: Option<Value>,
    }

    let parsed: Event = serde_json::from_str(if multiline.is_empty() {
        data.unwrap_or_default()
    } else {
        &multiline
    })
    .unwrap_or_default();

    let status = parsed
        .response
        .as_ref()
        .and_then(|res| res.status.as_deref());
    if matches!(event, "response.cancelled" | "response.canceled")
        || matches!(
            parsed.kind.as_str(),
            "response.cancelled" | "response.canceled"
        )
        || matches!(status, Some("cancelled" | "canceled"))
    {
        return Some(Outcome::Cancelled(Reason::UpstreamCancelled));
    }
    if event == "response.incomplete"
        || parsed.kind == "response.incomplete"
        || status == Some("incomplete")
    {
        return Some(Outcome::Error(DiagnosticError::new(ErrorClass::Incomplete)));
    }

    let error = parsed
        .response
        .as_ref()
        .and_then(|res| res.error.as_ref())
        .or(parsed.error.as_ref());
    if !matches!(event, "error" | "response.failed")
        && !matches!(parsed.kind.as_str(), "error" | "response.failed")
        && status != Some("failed")
        && !error.is_some_and(Value::is_object)
    {
        return None;
    }
    Some(Outcome::Error(classify_event_error(
        error,
        parsed.code.as_deref(),
    )))
}

fn classify_event_error(error: Option<&Value>, top_level_code: Option<&str>) -> DiagnosticError {
    if error.is_some_and(crate::proxy::error::is_billing_error_object) {
        return DiagnosticError::new(ErrorClass::Billing);
    }
    let code = error
        .and_then(|error| {
            error
                .get("code")
                .and_then(Value::as_str)
                .or_else(|| error.get("type").and_then(Value::as_str))
        })
        .or(top_level_code);
    let status = error
        .and_then(|error| error.get("status_code").or_else(|| error.get("status")))
        .and_then(Value::as_u64)
        .filter(|status| (400..600).contains(status));
    if let Some(status) = status {
        return DiagnosticError::http(status as u16);
    }
    let class = match code {
        Some("rate_limit_exceeded" | "rate_limit_error" | "too_many_requests") => {
            ErrorClass::RateLimited
        }
        Some("invalid_api_key" | "authentication_error" | "unauthorized") => {
            ErrorClass::Authentication
        }
        Some("permission_denied" | "permission_error" | "forbidden") => ErrorClass::Permission,
        Some(
            "invalid_request_error"
            | "invalid_encrypted_content"
            | "context_length_exceeded"
            | "model_not_found",
        ) => ErrorClass::InvalidRequest,
        Some("timeout" | "request_timeout" | "gateway_timeout") => ErrorClass::Timeout,
        _ => ErrorClass::Upstream,
    };
    DiagnosticError::new(class)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn observes_fragmented_error_after_oversized_event_without_retaining_content() {
        let mut inspection = SseInspection::default();
        assert!(inspection.feed(b"data: ").is_none());
        assert!(inspection.feed(&vec![b'x'; MAX_EVENT_BYTES]).is_none());
        assert!(inspection.event.is_empty());
        assert!(inspection.feed(b"\r\n\r\nevent: response.fai").is_none());
        assert!(inspection
            .feed(b"led\r\ndata: {\"response\":{\"error\":{\"message\":\"private text\",")
            .is_none());
        let outcome = inspection.feed(b"\"code\":\"rate_limit_exceeded\"}}}\r\n\r\n");
        assert!(
            matches!(outcome, Some(Outcome::Error(error)) if error.class == ErrorClass::RateLimited)
        );
        assert!(inspection.event.is_empty());
    }

    #[test]
    fn output_text_with_error_keywords_is_not_a_protocol_failure() {
        let mut inspection = SseInspection::default();
        assert!(inspection.feed(
            b"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"response.failed invalid_api_key\"}\n\n"
        ).is_none());
    }
}
