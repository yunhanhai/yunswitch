use super::{DiagnosticError, ErrorClass, Outcome, Reason, RequestGuard, ResponseProtocol};
use axum::{
    body::{Body, Bytes},
    response::Response,
};
use http::header::{CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_TYPE};
use http_body::{Body as HttpBody, Frame, SizeHint};
use serde_json::Value;
use std::{
    error::Error,
    pin::Pin,
    task::{Context, Poll},
};

/// Cardinality from the client request, before the forwarding layer consumes it.
#[derive(Clone, Copy)]
pub(crate) struct ExpectedCandidates(pub usize);

pub(super) fn observe(
    mut response: Response,
    mut guard: RequestGuard,
    head: bool,
    protocol: ResponseProtocol,
) -> Response {
    if !response.status().is_success() {
        let error = response
            .extensions_mut()
            .remove::<DiagnosticError>()
            .unwrap_or_else(|| DiagnosticError::http(response.status().as_u16()));
        guard.finish(Outcome::Error(error));
        return response;
    }
    if head || response.status() == http::StatusCode::NO_CONTENT {
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
    let expected = response
        .extensions_mut()
        .remove::<ExpectedCandidates>()
        .map_or(1, |count| count.0);
    // Hyper may stop polling after the declared length without asking the
    // wrapped stream for None. Settle when its final declared byte is handed on.
    let remaining = response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok()?.parse::<u64>().ok())
        .or_else(|| response.body().size_hint().exact());
    // Completion accounting is independent of the bounded diagnostic timeline.
    let inspection = if protocol == ResponseProtocol::Http {
        Inspection::Http
    } else if !plain {
        Inspection::Unavailable
    } else if sse {
        Inspection::Sse(SseInspection::new(protocol, expected))
    } else {
        Inspection::Json(JsonInspection::new(protocol, expected))
    };
    if response.body().is_end_stream() || remaining == Some(0) {
        guard.finish(inspection.eof());
        return response;
    }
    let (parts, body) = response.into_parts();
    Response::from_parts(
        parts,
        Body::new(ObservedBody {
            body,
            inspection: Some(inspection),
            guard,
            sse,
            emitted: false,
            terminal: None,
            remaining,
        }),
    )
}

struct ObservedBody {
    body: Body,
    inspection: Option<Inspection>,
    guard: RequestGuard,
    sse: bool,
    emitted: bool,
    terminal: Option<Outcome>,
    remaining: Option<u64>,
}

impl ObservedBody {
    fn finish(&mut self, outcome: Outcome) {
        if self.terminal.is_none() {
            self.terminal = Some(outcome);
            self.inspection = None;
            self.guard.finish(outcome);
        }
    }

    fn finish_eof(&mut self) {
        if let Some(inspection) = self.inspection.take() {
            self.finish(inspection.eof());
        }
    }
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
                    this.remaining = this
                        .remaining
                        .and_then(|left| left.checked_sub(bytes.len() as u64));
                    if this.sse && !this.emitted {
                        this.emitted = true;
                        if let Some(trace) = &this.guard.trace {
                            trace.streaming();
                        }
                    }
                    if let Some(outcome) = this
                        .inspection
                        .as_mut()
                        .and_then(|inspection| inspection.feed(bytes))
                    {
                        // Settle before returning the terminal frame. A client
                        // may close immediately, and stop() must not turn this
                        // already delivered terminal into cancellation.
                        this.finish(outcome);
                    }
                }
                if this.body.is_end_stream() || this.remaining == Some(0) {
                    this.finish_eof();
                }
            }
            Poll::Ready(Some(Err(error))) => {
                this.finish(Outcome::Error(stream_error(error)));
            }
            Poll::Ready(None) => this.finish_eof(),
            Poll::Pending => {}
        }
        // Observe only; even oversized or malformed frames reach the client.
        result
    }

    fn is_end_stream(&self) -> bool {
        self.body.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.body.size_hint()
    }
}

fn stream_error(error: &(dyn Error + 'static)) -> DiagnosticError {
    use crate::proxy::providers::StreamTransportError;
    DiagnosticError::new(match StreamTransportError::from_error(error) {
        StreamTransportError::Timeout => ErrorClass::Timeout,
        StreamTransportError::Interrupted => ErrorClass::ResponseInterrupted,
    })
}

fn incomplete() -> Outcome {
    Outcome::Error(DiagnosticError::new(ErrorClass::Incomplete))
}

const MAX_EVENT_BYTES: usize = 256 * 1024;
const MAX_CANDIDATES: usize = 32;

// All input retained for inspection is bounded. ProtocolState contains only
// fixed counters/flags; parsed values never escape one complete event.
enum Inspection {
    Http,
    Unavailable,
    Sse(SseInspection),
    Json(JsonInspection),
}

impl Inspection {
    fn feed(&mut self, bytes: &[u8]) -> Option<Outcome> {
        match self {
            Self::Sse(inspection) => inspection.feed(bytes),
            Self::Json(inspection) => {
                inspection.feed(bytes);
                None
            }
            Self::Http | Self::Unavailable => None,
        }
    }

    fn eof(self) -> Outcome {
        match self {
            Self::Http => Outcome::Success,
            Self::Unavailable => Outcome::Unconfirmed(Reason::UnsupportedResponse),
            Self::Sse(inspection) => inspection.eof(),
            Self::Json(inspection) => inspection.eof(),
        }
    }
}

fn bounded_append(buffer: &mut Vec<u8>, bytes: &[u8]) -> bool {
    if bytes.len() > MAX_EVENT_BYTES - buffer.len() {
        buffer.clear();
        return false;
    }
    let needed = buffer.len() + bytes.len();
    if needed > buffer.capacity() {
        let capacity = needed
            .max(buffer.capacity().saturating_mul(2))
            .min(MAX_EVENT_BYTES);
        buffer.reserve_exact(capacity - buffer.len());
    }
    buffer.extend_from_slice(bytes);
    true
}

struct JsonInspection {
    body: Vec<u8>,
    oversized: bool,
    protocol: ProtocolState,
}

impl JsonInspection {
    fn new(protocol: ResponseProtocol, expected: usize) -> Self {
        Self {
            body: Vec::new(),
            oversized: false,
            protocol: ProtocolState::new(protocol, expected),
        }
    }

    fn feed(&mut self, bytes: &[u8]) {
        if !self.oversized && !bounded_append(&mut self.body, bytes) {
            self.oversized = true;
        }
    }

    fn eof(mut self) -> Outcome {
        if self.oversized {
            return Outcome::Unconfirmed(Reason::ObservationLimit);
        }
        let Ok(value) = serde_json::from_slice::<Value>(&self.body) else {
            return Outcome::Unconfirmed(Reason::UnsupportedResponse);
        };
        self.protocol
            .inspect("", &value, false)
            .unwrap_or_else(|| self.protocol.eof())
    }
}

struct SseInspection {
    event: Vec<u8>,
    line_has_content: bool,
    oversized: bool,
    protocol: ProtocolState,
}

impl SseInspection {
    fn new(protocol: ResponseProtocol, expected: usize) -> Self {
        Self {
            event: Vec::new(),
            line_has_content: false,
            oversized: false,
            protocol: ProtocolState::new(protocol, expected),
        }
    }

    fn feed(&mut self, bytes: &[u8]) -> Option<Outcome> {
        for part in bytes.split_inclusive(|b| *b == b'\n') {
            let end = part.last() == Some(&b'\n');
            let line = if end { &part[..part.len() - 1] } else { part };
            self.line_has_content |= line.iter().any(|b| *b != b'\r');
            if end && !self.line_has_content {
                let outcome = if self.oversized {
                    None
                } else {
                    self.protocol.inspect_event(&self.event)
                };
                self.event.clear();
                self.oversized = false;
                if outcome.is_some() {
                    return outcome;
                }
            } else if !self.oversized && !bounded_append(&mut self.event, part) {
                self.oversized = true;
                self.protocol.uncertainty = Some(Reason::ObservationLimit);
            }
            if end {
                self.line_has_content = false;
            }
        }
        None
    }

    fn eof(self) -> Outcome {
        self.protocol.eof()
    }
}

struct ProtocolState {
    protocol: ResponseProtocol,
    uncertainty: Option<Reason>,
    message_stop: Option<Outcome>,
    expected: usize,
    seen: u32,
    finished: u32,
    truncated: u32,
    candidate_limit: bool,
}

impl ProtocolState {
    fn new(protocol: ResponseProtocol, expected: usize) -> Self {
        let candidate_limit = matches!(protocol, ResponseProtocol::Chat | ResponseProtocol::Gemini)
            && !(1..=MAX_CANDIDATES).contains(&expected);
        Self {
            protocol,
            uncertainty: candidate_limit.then_some(Reason::ObservationLimit),
            message_stop: None,
            expected: expected.clamp(1, MAX_CANDIDATES),
            seen: 0,
            finished: 0,
            truncated: 0,
            candidate_limit,
        }
    }

    fn eof(&self) -> Outcome {
        self.uncertainty
            .map(Outcome::Unconfirmed)
            .unwrap_or_else(incomplete)
    }

    fn unknown(&mut self) {
        // Preserve the more actionable observation-limit reason.
        self.uncertainty.get_or_insert(Reason::UnsupportedResponse);
    }

    fn inspect_event(&mut self, bytes: &[u8]) -> Option<Outcome> {
        let Ok(block) = std::str::from_utf8(bytes) else {
            self.unknown();
            return None;
        };
        let event = block
            .trim_start_matches('\u{feff}')
            .lines()
            .filter_map(|line| line.strip_prefix("event:"))
            .next_back()
            .map(str::trim)
            .unwrap_or_default();
        let Some(data) = crate::proxy::sse::observed_sse_data(bytes) else {
            // Heartbeats, comments, and empty SSE records are not content.
            return None;
        };
        if data.trim() == "[DONE]" {
            return if self.protocol == ResponseProtocol::Chat {
                Some(self.candidates_outcome().unwrap_or_else(|| self.eof()))
            } else {
                None
            };
        }
        let Ok(value) = serde_json::from_str::<Value>(&data) else {
            self.unknown();
            return None;
        };
        self.inspect(event, &value, true)
    }

    fn inspect(&mut self, event: &str, value: &Value, streaming: bool) -> Option<Outcome> {
        if !value.is_object() {
            self.unknown();
            return None;
        }
        let kind = value.get("type").and_then(Value::as_str).unwrap_or(event);
        let response = value.get("response").unwrap_or(value);
        let status = response.get("status").and_then(Value::as_str);
        let error = response.get("error").or_else(|| value.get("error"));
        // Only structured errors influence classification; never text content.
        if self.protocol == ResponseProtocol::Responses {
            if matches!(kind, "response.cancelled" | "response.canceled")
                || matches!(event, "response.cancelled" | "response.canceled")
                || matches!(status, Some("cancelled" | "canceled"))
            {
                return Some(Outcome::Cancelled(Reason::UpstreamCancelled));
            }
            if kind == "response.incomplete"
                || event == "response.incomplete"
                || status == Some("incomplete")
            {
                return Some(incomplete());
            }
        }
        if kind == "error" || event == "error" || error.is_some_and(Value::is_object) {
            return Some(Outcome::Error(classify_event_error(
                error,
                value.get("code").and_then(Value::as_str),
            )));
        }
        match self.protocol {
            ResponseProtocol::Responses => {
                if kind == "response.failed"
                    || event == "response.failed"
                    || status == Some("failed")
                {
                    return Some(Outcome::Error(classify_event_error(
                        error,
                        value.get("code").and_then(Value::as_str),
                    )));
                }
                if kind == "response.completed"
                    || event == "response.completed"
                    || status == Some("completed")
                {
                    return Some(Outcome::Success);
                }
                if !streaming || (!kind.starts_with("response.") && !event.starts_with("response."))
                {
                    self.unknown();
                }
            }
            ResponseProtocol::Messages => {
                let stop = value
                    .pointer("/delta/stop_reason")
                    .or_else(|| value.get("stop_reason"))
                    .and_then(Value::as_str);
                if let Some(stop) = stop {
                    self.message_stop = Some(messages_finish(stop).unwrap_or_else(|| {
                        self.unknown();
                        Outcome::Unconfirmed(Reason::UnsupportedResponse)
                    }));
                }
                if kind == "message_stop" || event == "message_stop" {
                    return Some(self.message_stop.unwrap_or_else(|| {
                        self.uncertainty
                            .map(Outcome::Unconfirmed)
                            .unwrap_or_else(incomplete)
                    }));
                }
                if !streaming {
                    return self.message_stop.or_else(|| {
                        self.unknown();
                        None
                    });
                }
                if !matches!(
                    kind,
                    "message_start"
                        | "message_delta"
                        | "content_block_start"
                        | "content_block_delta"
                        | "content_block_stop"
                        | "ping"
                ) {
                    self.unknown();
                }
            }
            ResponseProtocol::Chat | ResponseProtocol::Gemini => {
                let gemini = self.protocol == ResponseProtocol::Gemini;
                if gemini
                    && value
                        .pointer("/promptFeedback/blockReason")
                        .and_then(Value::as_str)
                        .is_some_and(|reason| {
                            !reason.is_empty() && reason != "BLOCK_REASON_UNSPECIFIED"
                        })
                {
                    return Some(Outcome::Success);
                }
                let name = if gemini { "candidates" } else { "choices" };
                if let Some(candidates) = value.get(name).and_then(Value::as_array) {
                    if candidates.len() > MAX_CANDIDATES {
                        self.candidate_limit = true;
                        self.uncertainty = Some(Reason::ObservationLimit);
                    }
                    for (position, candidate) in candidates.iter().take(MAX_CANDIDATES).enumerate()
                    {
                        if !candidate.is_object() {
                            self.unknown();
                            continue;
                        }
                        let index = match candidate.get("index") {
                            Some(index) => {
                                match index.as_u64().and_then(|index| usize::try_from(index).ok()) {
                                    Some(index) => index,
                                    None => {
                                        self.unknown();
                                        continue;
                                    }
                                }
                            }
                            None if streaming && self.expected > 1 => {
                                self.unknown();
                                continue;
                            }
                            None => position,
                        };
                        if index >= MAX_CANDIDATES {
                            self.candidate_limit = true;
                            self.uncertainty = Some(Reason::ObservationLimit);
                            continue;
                        }
                        let bit = 1u32 << index;
                        self.seen |= bit;
                        let finish_value = candidate.get(if gemini {
                            "finishReason"
                        } else {
                            "finish_reason"
                        });
                        if finish_value.is_some_and(|value| !value.is_null() && !value.is_string())
                        {
                            self.unknown();
                        }
                        let finish = finish_value.and_then(Value::as_str);
                        if let Some(reason) = finish {
                            match candidate_finish(reason, gemini) {
                                Some(truncated) => {
                                    self.finished |= bit;
                                    if truncated {
                                        self.truncated |= bit;
                                    }
                                }
                                None => self.unknown(),
                            }
                        }
                    }
                    return self.candidates_outcome();
                }
                if !(streaming
                    && (value.get("usage").is_some() || value.get("usageMetadata").is_some()))
                {
                    self.unknown();
                }
            }
            ResponseProtocol::Http => return Some(Outcome::Success),
        }
        None
    }

    fn candidates_outcome(&self) -> Option<Outcome> {
        let expected = if self.expected == MAX_CANDIDATES {
            u32::MAX
        } else {
            (1u32 << self.expected) - 1
        };
        if self.uncertainty.is_some()
            || self.candidate_limit
            || self.finished & expected != expected
            || self.finished & self.seen != self.seen
        {
            return None;
        }
        Some(if self.truncated != 0 {
            incomplete()
        } else {
            Outcome::Success
        })
    }
}

fn messages_finish(reason: &str) -> Option<Outcome> {
    match reason {
        "max_tokens" | "model_context_window_exceeded" | "context_window_exceeded" => {
            Some(incomplete())
        }
        "end_turn" | "stop_sequence" | "tool_use" | "pause_turn" | "refusal" => {
            Some(Outcome::Success)
        }
        _ => None,
    }
}

fn candidate_finish(reason: &str, gemini: bool) -> Option<bool> {
    match (gemini, reason) {
        (false, "stop" | "tool_calls" | "function_call" | "content_filter") => Some(false),
        (false, "length") => Some(true),
        (
            true,
            "STOP" | "SAFETY" | "RECITATION" | "BLOCKLIST" | "PROHIBITED_CONTENT" | "SPII"
            | "LANGUAGE",
        ) => Some(false),
        (true, "MAX_TOKENS" | "MALFORMED_FUNCTION_CALL" | "UNEXPECTED_TOOL_CALL") => Some(true),
        _ => None,
    }
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
        Some("timeout" | "request_timeout" | "gateway_timeout" | "stream_timeout") => {
            ErrorClass::Timeout
        }
        Some("stream_error") => ErrorClass::ResponseInterrupted,
        Some("incomplete_response") => ErrorClass::Incomplete,
        _ => ErrorClass::Upstream,
    };
    DiagnosticError::new(class)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proxy::diagnostics::Diagnostics;
    use futures::StreamExt;
    use http_body_util::BodyExt;
    use serde_json::json;
    use std::sync::Arc;

    fn phase(outcome: Outcome) -> &'static str {
        match outcome {
            Outcome::Success => "success",
            Outcome::Error(error) if error.class == ErrorClass::Incomplete => "incomplete",
            Outcome::Error(error) if error.class == ErrorClass::Timeout => "timeout",
            Outcome::Error(_) => "error",
            Outcome::Cancelled(_) => "cancelled",
            Outcome::Unconfirmed(Reason::ObservationLimit) => "limit",
            Outcome::Unconfirmed(_) => "unknown",
        }
    }

    fn frame(value: Value) -> Vec<u8> {
        format!("data: {value}\n\n").into_bytes()
    }

    #[test]
    fn terminal_events_distinguish_completed_incomplete_cancelled_and_failure() {
        for (value, expected) in [
            (
                json!({"type":"response.completed","response":{"status":"completed"}}),
                "success",
            ),
            (
                json!({"type":"response.incomplete","response":{"status":"incomplete","error":{"message":"private"}}}),
                "incomplete",
            ),
            (
                json!({"type":"response.cancelled","response":{"status":"cancelled"}}),
                "cancelled",
            ),
            (
                json!({"type":"response.failed","response":{"status":"failed","error":{"type":"stream_error"}}}),
                "error",
            ),
            (
                json!({"type":"error","error":{"type":"stream_timeout","message":"private"}}),
                "timeout",
            ),
            (
                json!({"type":"error","error":{"type":"incomplete_response"}}),
                "incomplete",
            ),
        ] {
            let mut inspection = SseInspection::new(ResponseProtocol::Responses, 1);
            assert_eq!(phase(inspection.feed(&frame(value)).unwrap()), expected);
        }
        let mut inspection = SseInspection::new(ResponseProtocol::Responses, 1);
        assert!(inspection
            .feed(&frame(
                json!({"type":"response.output_text.delta","delta":"response.failed private"})
            ))
            .is_none());
        assert_eq!(phase(inspection.eof()), "incomplete");
    }

    #[test]
    fn messages_remember_truncation_until_stop_and_accept_complete_tool_turns() {
        let mut bare_stop = SseInspection::new(ResponseProtocol::Messages, 1);
        assert_eq!(
            phase(
                bare_stop
                    .feed(&frame(json!({"type":"message_stop"})))
                    .unwrap()
            ),
            "incomplete"
        );
        for (reason, expected) in [
            ("end_turn", "success"),
            ("tool_use", "success"),
            ("refusal", "success"),
            ("max_tokens", "incomplete"),
            ("model_context_window_exceeded", "incomplete"),
        ] {
            let mut inspection = SseInspection::new(ResponseProtocol::Messages, 1);
            assert!(inspection
                .feed(&frame(
                    json!({"type":"message_delta","delta":{"stop_reason":reason}})
                ))
                .is_none());
            assert_eq!(
                phase(
                    inspection
                        .feed(&frame(json!({"type":"message_stop"})))
                        .unwrap()
                ),
                expected
            );
        }
        let mut inspection = SseInspection::new(ResponseProtocol::Messages, 1);
        assert!(inspection
            .feed(&frame(
                json!({"type":"message_delta","delta":{"stop_reason":"end_turn"}})
            ))
            .is_none());
        assert_eq!(
            phase(inspection.eof()),
            "incomplete",
            "delta is not the message terminal"
        );
    }

    #[test]
    fn candidate_completion_waits_for_every_requested_and_seen_choice() {
        for protocol in [ResponseProtocol::Chat, ResponseProtocol::Gemini] {
            let candidates = |index, finish: Option<&str>| match protocol {
                ResponseProtocol::Chat => {
                    json!({"choices":[{"index":index,"finish_reason":finish}]})
                }
                _ => json!({"candidates":[{"index":index,"finishReason":finish}]}),
            };
            let normal = if protocol == ResponseProtocol::Chat {
                "stop"
            } else {
                "STOP"
            };
            let truncated = if protocol == ResponseProtocol::Chat {
                "length"
            } else {
                "MAX_TOKENS"
            };
            let mut inspection = SseInspection::new(protocol, 2);
            assert!(inspection
                .feed(&frame(candidates(0, Some(normal))))
                .is_none());
            assert_eq!(phase(inspection.protocol.eof()), "incomplete");
            assert!(inspection.feed(&frame(candidates(1, None))).is_none());
            assert_eq!(
                phase(
                    inspection
                        .feed(&frame(candidates(1, Some(truncated))))
                        .unwrap()
                ),
                "incomplete"
            );

            let mut inspection = SseInspection::new(protocol, 1);
            assert!(inspection.feed(&frame(candidates(1, None))).is_none());
            assert!(inspection
                .feed(&frame(candidates(0, Some(normal))))
                .is_none());
            assert_eq!(
                phase(
                    inspection
                        .feed(&frame(candidates(1, Some(normal))))
                        .unwrap()
                ),
                "success"
            );

            let mut single = SseInspection::new(protocol, 1);
            assert_eq!(
                phase(single.feed(&frame(candidates(0, Some(normal)))).unwrap()),
                "success",
                "finish without DONE is valid"
            );
        }
    }

    #[test]
    fn malformed_candidate_identity_cannot_be_hidden_by_a_later_completed_choice() {
        for value in [
            json!({"choices":[{"index":"private-invalid-index","finish_reason":"stop"}]}),
            json!({"choices":[{"index":0,"finish_reason":"future-unknown-reason"}]}),
            json!({"choices":[null,{"index":0,"finish_reason":"stop"}]}),
            json!({"choices":[{"index":0,"finish_reason":42}]}),
        ] {
            let mut inspection = SseInspection::new(ResponseProtocol::Chat, 1);
            assert!(inspection.feed(&frame(value)).is_none());
            assert!(inspection
                .feed(&frame(
                    json!({"choices":[{"index":0,"finish_reason":"stop"}]})
                ))
                .is_none());
            assert_eq!(phase(inspection.eof()), "unknown");
        }
    }

    #[test]
    fn unknown_and_oversized_observation_is_bounded_and_can_recover_at_terminal() {
        let mut inspection = SseInspection::new(ResponseProtocol::Responses, 1);
        for _ in 0..512 {
            assert!(inspection.feed(&[b'x'; 4096]).is_none());
            assert!(inspection.event.len() <= MAX_EVENT_BYTES);
            assert!(inspection.event.capacity() <= MAX_EVENT_BYTES);
        }
        assert_eq!(phase(inspection.protocol.eof()), "limit");
        for part in [b"\r".as_slice(), b"\n\r", b"\n"] {
            assert!(inspection.feed(part).is_none());
        }
        let terminal = "event: response.completed\r\ndata: {\"type\":\"response.completed\",\r\ndata: \"response\":{\"status\":\"completed\",\"output\":\"模型\"}}\r\n\r\n";
        let mut result = None;
        for byte in terminal.as_bytes().chunks(1) {
            result = result.or_else(|| inspection.feed(byte));
        }
        assert_eq!(phase(result.unwrap()), "success");

        let mut malformed = SseInspection::new(ResponseProtocol::Responses, 1);
        assert!(malformed.feed(b"data: not-json\n\n").is_none());
        assert_eq!(phase(malformed.eof()), "unknown");

        let mut too_many = SseInspection::new(ResponseProtocol::Chat, MAX_CANDIDATES + 1);
        assert!(too_many
            .feed(&frame(
                json!({"choices":[{"index":0,"finish_reason":"stop"}]})
            ))
            .is_none());
        assert_eq!(phase(too_many.eof()), "limit");
    }

    #[test]
    fn done_does_not_make_partial_candidates_successful() {
        let mut inspection = SseInspection::new(ResponseProtocol::Chat, 2);
        assert!(inspection
            .feed(&frame(
                json!({"choices":[{"index":0,"finish_reason":"stop"}]})
            ))
            .is_none());
        assert_eq!(
            phase(inspection.feed(b"data: [DONE]\n\n").unwrap()),
            "incomplete"
        );
        let mut empty = SseInspection::new(ResponseProtocol::Chat, 1);
        assert_eq!(
            phase(empty.feed(b"data: [DONE]\n\n").unwrap()),
            "incomplete"
        );
    }

    #[test]
    fn bounded_json_recognizes_semantic_failures_and_unknown_content() {
        for (protocol, value, expected) in [
            (
                ResponseProtocol::Responses,
                json!({"status":"failed","error":{"code":"server_error"}}),
                "error",
            ),
            (
                ResponseProtocol::Responses,
                json!({"status":"completed","output":[]}),
                "success",
            ),
            (
                ResponseProtocol::Responses,
                json!({"status":"incomplete"}),
                "incomplete",
            ),
            (
                ResponseProtocol::Responses,
                json!({"status":"cancelled"}),
                "cancelled",
            ),
            (
                ResponseProtocol::Messages,
                json!({"type":"message","stop_reason":"end_turn","content":[]}),
                "success",
            ),
            (
                ResponseProtocol::Messages,
                json!({"type":"message","stop_reason":"max_tokens"}),
                "incomplete",
            ),
            (
                ResponseProtocol::Chat,
                json!({"choices":[{"index":0,"finish_reason":"stop"}]}),
                "success",
            ),
            (
                ResponseProtocol::Gemini,
                json!({"candidates":[{"index":0,"finishReason":"STOP"}]}),
                "success",
            ),
            (
                ResponseProtocol::Responses,
                json!({"unrecognized":"private"}),
                "unknown",
            ),
        ] {
            let mut inspection = JsonInspection::new(protocol, 1);
            for chunk in value.to_string().as_bytes().chunks(3) {
                inspection.feed(chunk);
            }
            assert_eq!(phase(inspection.eof()), expected);
        }
        let mut inspection = JsonInspection::new(ResponseProtocol::Responses, 1);
        inspection.feed(&vec![b'x'; MAX_EVENT_BYTES + 1]);
        assert!(inspection.body.is_empty());
        assert_eq!(phase(inspection.eof()), "limit");
    }

    fn tracked_response(
        body: Body,
        content_type: &str,
        protocol: ResponseProtocol,
    ) -> (Arc<Diagnostics>, Response) {
        let store = Arc::new(Diagnostics::default());
        store.start();
        let guard = store.begin("synthetic").unwrap();
        let response = Response::builder()
            .header(CONTENT_TYPE, content_type)
            .body(body)
            .unwrap();
        let response = observe(response, guard, false, protocol);
        (store, response)
    }

    #[tokio::test]
    async fn exact_length_delivery_settles_even_without_an_eof_poll() {
        for protocol in [ResponseProtocol::Http, ResponseProtocol::Responses] {
            for length in [2, 3] {
                let store = Arc::new(Diagnostics::default());
                store.start();
                let guard = store.begin("synthetic").unwrap();
                let stream = futures::stream::once(async {
                    Ok::<_, std::io::Error>(Bytes::from_static(b"{}"))
                })
                .chain(futures::stream::pending());
                let response = Response::builder()
                    .header(CONTENT_LENGTH, length)
                    .body(Body::from_stream(stream))
                    .unwrap();
                let mut body = observe(response, guard, false, protocol).into_body();
                assert_eq!(
                    body.frame().await.unwrap().unwrap().into_data().unwrap(),
                    b"{}".as_slice()
                );
                drop(body);
                let registry = store.lock();
                assert_eq!(registry.totals.pending, 0);
                if length == 3 {
                    assert_eq!(registry.totals.cancelled, 1);
                } else if protocol == ResponseProtocol::Http {
                    assert_eq!(registry.totals.succeeded, 1);
                } else {
                    assert_eq!(registry.totals.unconfirmed, 1);
                }
            }
        }
    }

    #[tokio::test]
    async fn explicit_terminal_settles_before_immediate_close_and_preserves_original_bytes() {
        let bytes = Bytes::from_static(b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n");
        let expected = bytes.clone();
        let stream = async_stream::stream! {
            yield Ok::<_, std::io::Error>(bytes);
            std::future::pending::<()>().await;
        };
        let (store, response) = tracked_response(
            Body::from_stream(stream),
            "text/event-stream",
            ResponseProtocol::Responses,
        );
        let mut body = response.into_body();
        assert_eq!(
            body.frame().await.unwrap().unwrap().into_data().unwrap(),
            expected
        );
        assert_eq!(store.lock().totals.succeeded, 1);
        assert_eq!(store.lock().totals.pending, 0);
        store.stop();
        drop(body);
        assert_eq!(store.lock().totals.succeeded, 1);
        assert_eq!(store.lock().totals.cancelled, 0);
    }

    #[tokio::test]
    async fn first_terminal_wins_over_tail_failure_and_unknown_eof_never_succeeds() {
        let bytes = Bytes::from_static(
            b"data: {\"type\":\"response.completed\"}\n\ndata: {\"type\":\"response.failed\"}\n\n",
        );
        let expected = bytes.clone();
        let (store, response) = tracked_response(
            Body::from(bytes),
            "text/event-stream",
            ResponseProtocol::Responses,
        );
        assert_eq!(
            response.into_body().collect().await.unwrap().to_bytes(),
            expected
        );
        assert_eq!(store.lock().totals.succeeded, 1);
        assert_eq!(store.lock().totals.failed, 0);

        let bytes = Bytes::from_static(
            b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"private\"}\n\n",
        );
        let (store, response) = tracked_response(
            Body::from(bytes),
            "text/event-stream",
            ResponseProtocol::Responses,
        );
        response.into_body().collect().await.unwrap();
        assert_eq!(store.lock().totals.succeeded, 0);
        assert_eq!(store.lock().totals.failed, 1);
    }

    #[tokio::test]
    async fn untracked_requests_are_observed_and_compressed_content_stays_unconfirmed() {
        let store = Arc::new(Diagnostics::default());
        store.start();
        let live: Vec<_> = (0..128)
            .map(|_| store.begin("synthetic").unwrap())
            .collect();
        let guard = store.begin("synthetic").unwrap();
        assert!(guard.trace.is_none());
        let response = Response::builder()
            .header(CONTENT_TYPE, "text/event-stream")
            .body(Body::from("data: {\"type\":\"response.completed\"}\n\n"))
            .unwrap();
        observe(response, guard, false, ResponseProtocol::Responses)
            .into_body()
            .collect()
            .await
            .unwrap();
        assert_eq!(store.lock().totals.succeeded, 1);
        assert_eq!(store.lock().totals.pending, 128);
        drop(live);

        let guard = store.begin("synthetic").unwrap();
        let response = Response::builder()
            .header(CONTENT_ENCODING, "unknown-compression")
            .body(Body::from("private compressed bytes"))
            .unwrap();
        let bytes = observe(response, guard, false, ResponseProtocol::Responses)
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes();
        assert_eq!(bytes.as_ref(), b"private compressed bytes");
        assert_eq!(store.lock().totals.unconfirmed, 1);
    }
}
