//! Bounded, allowlisted input for the existing stream usage parsers.
//!
//! The collector is not an event log: text, reasoning, tool arguments, encrypted
//! history and unknown upstream fields are dropped immediately. Cumulative usage
//! replaces earlier usage while Claude's input/cache corrections are folded with
//! the same accumulator used by its parser.

use super::parser::ClaudeStreamUsage;
use serde_json::{json, Map, Value};

/// Unusually long metadata is omitted, not truncated into a colliding identity.
const MAX_METADATA_BYTES: usize = 512;

const USAGE_COUNTERS: &[&str] = &[
    "input_tokens",
    "output_tokens",
    "prompt_tokens",
    "completion_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
    "prompt_cache_hit_tokens",
];

#[derive(Default)]
pub(crate) struct StreamUsageSummary {
    claude: Option<ClaudeStreamUsage>,
    openai_usage: Option<Value>,
    first_id: Option<String>,
    first_model: Option<String>,
    codex_completed: Option<Value>,
    codex_model: Option<String>,
    gemini_usage: Option<Value>,
    gemini_model: Option<String>,
    gemini_id: Option<String>,
}

fn bounded_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|s| s.len() <= MAX_METADATA_BYTES)
        .map(str::to_owned)
}

fn copy_metadata(source: &Value, target: &mut Map<String, Value>, field: &str) {
    if let Some(value) = bounded_string(source.get(field)) {
        target.insert(field.to_string(), Value::String(value));
    }
}

fn copy_counters(source: &Value, fields: &[&str]) -> Value {
    let mut result = Map::new();
    for &field in fields {
        if let Some(value) = source.get(field) {
            // Keep invalid-field presence as null: the parsers intentionally
            // prioritize documented aliases even when their values are invalid.
            result.insert(
                field.to_string(),
                value.as_u64().map(Value::from).unwrap_or(Value::Null),
            );
        }
    }
    Value::Object(result)
}

fn usage_only(usage: &Value) -> Value {
    let mut result = copy_counters(usage, USAGE_COUNTERS);
    for field in ["input_tokens_details", "prompt_tokens_details"] {
        if let Some(details) = usage.get(field) {
            result[field] = copy_counters(details, &["cached_tokens", "cache_write_tokens"]);
        }
    }
    result
}

fn response_only(source: &Value) -> Value {
    let mut result = Map::new();
    copy_metadata(source, &mut result, "id");
    copy_metadata(source, &mut result, "model");
    if let Some(usage) = source.get("usage") {
        result.insert(
            "usage".to_string(),
            if usage.is_null() {
                Value::Null
            } else {
                usage_only(usage)
            },
        );
    }
    Value::Object(result)
}

impl StreamUsageSummary {
    pub(crate) fn push(&mut self, event: Value) {
        if self.first_id.is_none() {
            self.first_id = bounded_string(event.get("id")).filter(|s| !s.is_empty());
        }
        if self.first_model.is_none() {
            self.first_model = bounded_string(event.get("model")).filter(|s| !s.is_empty());
        }
        if event.get("usage").is_some_and(|usage| !usage.is_null()) {
            self.openai_usage = Some(response_only(&event));
        }

        match event.get("type").and_then(Value::as_str) {
            Some("message_start") => {
                let message = event.get("message").unwrap_or(&Value::Null);
                let safe_event = json!({
                    "type": "message_start",
                    "message": response_only(message),
                });
                self.claude.get_or_insert_default().push(&safe_event);
            }
            Some("message_delta") => {
                let mut safe_event = response_only(&event);
                safe_event["type"] = json!("message_delta");
                self.claude.get_or_insert_default().push(&safe_event);
            }
            Some("response.completed") => {
                if let Some(response) = event.get("response") {
                    if self.codex_completed.is_none() {
                        self.codex_completed = Some(json!({
                            "type": "response.completed",
                            "response": response_only(response),
                        }));
                    }
                    if self.codex_model.is_none() {
                        self.codex_model =
                            bounded_string(response.get("model")).filter(|s| !s.is_empty());
                    }
                }
            }
            _ => {}
        }

        if let Some(usage) = event.get("usageMetadata") {
            self.gemini_usage = Some(copy_counters(
                usage,
                &[
                    "promptTokenCount",
                    "totalTokenCount",
                    "cachedContentTokenCount",
                ],
            ));
        }
        if self.gemini_model.is_none() {
            self.gemini_model = bounded_string(event.get("modelVersion"));
        }
        if self.gemini_id.is_none() {
            self.gemini_id = bounded_string(event.get("responseId")).filter(|s| !s.is_empty());
        }
    }

    /// At most seven small events, independent of the number of stream chunks.
    pub(crate) fn into_events(self) -> Vec<Value> {
        let mut events = Vec::with_capacity(7);
        if let Some(claude) = self.claude {
            let usage = claude.into_usage();
            events.push(json!({
                "type": "message_start",
                "message": {
                    "id": usage.message_id,
                    "model": usage.model,
                    "usage": {
                        "input_tokens": usage.input_tokens,
                        "cache_read_input_tokens": usage.cache_read_tokens,
                        "cache_creation_input_tokens": usage.cache_creation_tokens,
                    },
                },
            }));
            events.push(json!({
                "type": "message_delta",
                "usage": {"output_tokens": usage.output_tokens},
            }));
        }
        // This precedes the final OpenAI chunk to retain its first-id fallback
        // and the model extractor's first nonempty model fallback.
        if self.first_id.is_some() || self.first_model.is_some() {
            events.push(json!({"id": self.first_id, "model": self.first_model}));
        }
        if let Some(usage) = self.openai_usage {
            events.push(usage);
        }
        if self.gemini_usage.is_some() || self.gemini_model.is_some() || self.gemini_id.is_some() {
            let mut event = json!({
                "modelVersion": self.gemini_model,
                "responseId": self.gemini_id,
            });
            if let Some(usage) = self.gemini_usage {
                event["usageMetadata"] = usage;
            }
            events.push(event);
        }
        if let Some(completed) = self.codex_completed {
            let needs_model_fallback = self.codex_model.as_deref().is_some_and(|model| {
                completed.pointer("/response/model").and_then(Value::as_str) != Some(model)
            });
            events.push(completed);
            if needs_model_fallback {
                events.push(json!({
                    "type": "response.completed",
                    "response": {"model": self.codex_model},
                }));
            }
        }
        events
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proxy::{
        handler_config::{
            UsageParserConfig, CLAUDE_PARSER_CONFIG, CODEX_PARSER_CONFIG, GEMINI_PARSER_CONFIG,
            OPENAI_PARSER_CONFIG,
        },
        usage::parser::TokenUsage,
    };

    fn compact(events: &[Value]) -> Vec<Value> {
        let mut summary = StreamUsageSummary::default();
        for event in events {
            summary.push(event.clone());
        }
        summary.into_events()
    }

    fn assert_equivalent(events: &[Value], config: UsageParserConfig) {
        let compacted = compact(events);
        let before = (config.stream_parser)(events);
        let after = (config.stream_parser)(&compacted);
        assert_eq!(
            serde_json::to_value(&before).unwrap(),
            serde_json::to_value(&after).unwrap()
        );
        assert_eq!(
            before.and_then(|usage| usage.message_id),
            after.and_then(|usage| usage.message_id)
        );
        assert_eq!(
            (config.model_extractor)(events, "outbound-model"),
            (config.model_extractor)(&compacted, "outbound-model")
        );
    }

    #[test]
    fn claude_preserves_input_correction_cache_pairs_and_first_identity() {
        let mut events = vec![json!({
            "type": "message_start",
            "message": {
                "id": "msg-first",
                "model": "claude-test",
                "content": [{"type": "text", "text": "private-prompt"}],
                "usage": {
                    "input_tokens": 200_000,
                    "cache_read_input_tokens": 180_000,
                    "cache_creation_input_tokens": 2_000,
                },
            },
        })];
        events.push(json!({
            "type": "message_delta",
            "usage": {
                "input_tokens": 80_000,
                "output_tokens": 2,
                "cache_read_input_tokens": 110_000,
                "cache_creation_input_tokens": 300,
            },
        }));
        events.push(json!({
            "type": "message_delta",
            "usage": {
                "input_tokens": 80_000,
                "output_tokens": 3,
                "cache_read_input_tokens": 120_000,
                "cache_creation_input_tokens": 500,
            },
        }));
        // A larger input and missing final cache fields must not overwrite the
        // paired correction from the prior delta.
        events.push(json!({
            "type": "message_delta",
            "usage": {"input_tokens": 90_000, "output_tokens": 4},
        }));
        assert_equivalent(&events, CLAUDE_PARSER_CONFIG);
        let usage = TokenUsage::from_claude_stream_events(&compact(&events)).unwrap();
        assert_eq!(usage.input_tokens, 80_000);
        assert_eq!(usage.output_tokens, 4);
        assert_eq!(usage.cache_read_tokens, 120_000);
        assert_eq!(usage.cache_creation_tokens, 500);
        assert_eq!(usage.message_id.as_deref(), Some("msg-first"));
    }

    #[test]
    fn claude_partial_cache_only_and_repeated_start_keep_existing_semantics() {
        let events = [
            json!({"type":"message_start","message":{
                "id":"msg-first","model":"claude-test",
                "usage":{"input_tokens":0,"cache_read_input_tokens":10},
            }}),
            json!({"type":"message_delta","usage":{"output_tokens":0}}),
            json!({"type":"message_delta","usage":{"input_tokens":10,"cache_read_input_tokens":5}}),
            json!({"type":"message_start","message":{
                "id":"msg-second","model":"ignored-second-model",
                "usage":{"input_tokens":20,"cache_creation_input_tokens":1},
            }}),
            json!({"type":"message_delta","usage":{"input_tokens":20,"cache_read_input_tokens":3}}),
        ];
        for end in 1..=events.len() {
            assert_equivalent(&events[..end], CLAUDE_PARSER_CONFIG);
        }
    }

    #[test]
    fn openai_keeps_final_usage_first_id_model_fallback_and_cache_alias_priority() {
        let mut events = vec![
            json!({"id":"chat-first","model":"initial-model","usage":null}),
            json!({"model":"last-model","usage":{
                "prompt_tokens":200,"completion_tokens":12,
                "prompt_cache_hit_tokens":100,
                "prompt_tokens_details":{"cached_tokens":0,"cache_write_tokens":4},
            }}),
        ];
        assert_equivalent(&events, OPENAI_PARSER_CONFIG);
        let usage = TokenUsage::from_openai_stream_events(&compact(&events)).unwrap();
        assert_eq!(usage.cache_read_tokens, 0);
        assert_eq!(usage.cache_creation_tokens, 4);
        assert_eq!(usage.message_id.as_deref(), Some("chat-first"));
        assert_eq!(usage.model.as_deref(), Some("last-model"));

        events.push(json!({"usage":{"prompt_tokens":200,"completion_tokens":13}}));
        assert_equivalent(&events, OPENAI_PARSER_CONFIG);
        // A malformed final usage is not replaced with an older valid usage.
        events.push(json!({"usage":{"completion_tokens":"private-invalid-value"}}));
        assert_equivalent(&events, OPENAI_PARSER_CONFIG);
        assert!(!serde_json::to_string(&compact(&events))
            .unwrap()
            .contains("private-invalid-value"));
    }

    #[test]
    fn codex_keeps_first_completed_usage_and_later_model_fallback() {
        let mut events = vec![json!({
            "type":"response.completed",
            "response":{
                "id":"resp-first",
                "usage":{"input_tokens":500,"output_tokens":20,
                    "input_tokens_details":{"cached_tokens":300,"cache_write_tokens":5}},
                "output":[{"content":[{"text":"private-response-body"}]}],
            },
        })];
        events.push(json!({
            "type":"response.completed",
            "response":{"model":"fallback-model","usage":{"input_tokens":999,"output_tokens":999}},
        }));
        assert_equivalent(&events, CODEX_PARSER_CONFIG);
        let usage = TokenUsage::from_codex_stream_events_auto(&compact(&events)).unwrap();
        assert_eq!(usage.input_tokens, 500);
        assert_eq!(usage.cache_read_tokens, 300);
        assert_eq!(usage.cache_creation_tokens, 5);
        assert_eq!(usage.message_id.as_deref(), Some("resp-first"));
        assert!(!serde_json::to_string(&compact(&events))
            .unwrap()
            .contains("private-response-body"));
    }

    #[test]
    fn gemini_keeps_latest_totals_thought_tokens_cache_and_first_identity() {
        let events = [
            json!({"modelVersion":"gemini-first","responseId":"gemini-id",
                "usageMetadata":{"promptTokenCount":100,"totalTokenCount":101,"cachedContentTokenCount":50},
                "candidates":[{"content":{"parts":[{"text":"private-gemini-body"}]}}],
            }),
            json!({"modelVersion":"gemini-second","responseId":"later-id",
                "usageMetadata":{"promptTokenCount":100,"totalTokenCount":140,"candidatesTokenCount":20,"thoughtsTokenCount":20,"cachedContentTokenCount":60},
            }),
        ];
        assert_equivalent(&events, GEMINI_PARSER_CONFIG);
        let usage = TokenUsage::from_gemini_stream_chunks(&compact(&events)).unwrap();
        assert_eq!(usage.output_tokens, 40);
        assert_eq!(usage.cache_read_tokens, 60);
        assert_eq!(usage.model.as_deref(), Some("gemini-first"));
        assert_eq!(usage.message_id.as_deref(), Some("gemini-id"));
    }

    #[test]
    fn long_stream_drops_bodies_unknown_fields_and_bounds_metadata() {
        let secret = "synthetic-private-key-cookie-prompt-tool-encrypted-history";
        let mut summary = StreamUsageSummary::default();
        for output in 1..=20_000 {
            summary.push(json!({
                "id":"chat-id","model":"synthetic-model",
                "usage":{
                    "prompt_tokens":100,"completion_tokens":output,
                    "private":secret,"prompt_tokens_details":{"private":secret},
                },
                "choices":[{"delta":{"content":secret,"reasoning":secret,"tool_calls":[{"arguments":secret}]}}],
                "authorization":secret,"cookie":secret,"encrypted_content":secret,
            }));
        }
        summary.push(json!({
            "type":"response.completed",
            "response":{
                "id":"x".repeat(100_000), "model":"y".repeat(100_000),
                "usage":{"input_tokens":100,"output_tokens":20_000},
                "output":[{"text":secret}],
            },
        }));
        let events = summary.into_events();
        let serialized = serde_json::to_string(&events).unwrap();
        assert!(events.len() <= 7);
        assert!(serialized.len() < 4096);
        assert!(!serialized.contains(secret));
        let usage = TokenUsage::from_openai_stream_events(&events).unwrap();
        assert_eq!(usage.input_tokens, 100);
        assert_eq!(usage.output_tokens, 20_000);
        let codex = TokenUsage::from_codex_stream_events_auto(&events).unwrap();
        assert_eq!(codex.message_id, None);
        assert_eq!(codex.model, None);
    }
}
