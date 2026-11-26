//! Explicit, previewed adoption of existing Claude and Codex configurations.
//! Proofs contain only expiry and keyed digests; no credential snapshots are kept.
use super::shared_channel::{child, codex_document, codex_provider_id, merge_child, validate};
use super::{AppType, ProviderService, SharedChannelSaveResult};
use crate::error::AppError;
use crate::provider::{
    ClaudeModelConfig, CodexModelConfig, Provider, SharedChannelConnection, UniversalProvider,
};
use crate::proxy::providers::{
    get_claude_api_format, is_codex_official_provider, should_convert_codex_responses_to_anthropic,
    should_convert_codex_responses_to_chat, AuthStrategy, ClaudeAdapter, CodexAdapter,
    ProviderAdapter,
};
use crate::store::AppState;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Sha256;
use std::sync::LazyLock;

const PREVIEW_TTL_MS: i64 = 5 * 60 * 1000;
static PREVIEW_SECRET: LazyLock<[u8; 32]> = LazyLock::new(|| {
    let mut secret = [0; 32];
    secret[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    secret[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    secret
});

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SharedChannelLinkRequest {
    pub channel_id: String,
    pub name: String,
    pub claude_provider_id: String,
    pub codex_provider_id: String,
    pub key_source: LinkKeySource,
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkKeySource {
    Claude,
    Codex,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedChannelLinkCandidate {
    id: String,
    name: String,
    eligible: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
}

#[derive(Serialize)]
pub struct SharedChannelLinkCandidates {
    claude: Vec<SharedChannelLinkCandidate>,
    codex: Vec<SharedChannelLinkCandidate>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedChannelLinkAppPreview {
    app: String,
    provider_id: String,
    name: String,
    base_url: String,
    api_format: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    current: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedChannelLinkPreview {
    pub token: String,
    credentials_differ: bool,
    key_source: LinkKeySource,
    apps: Vec<SharedChannelLinkAppPreview>,
    expires_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedChannelLinkResult {
    pub channel_id: String,
    #[serde(flatten)]
    pub result: SharedChannelSaveResult,
}

struct Connection {
    url: String,
    key: String,
    format: String,
    key_field: Option<String>,
    model: Option<String>,
}

fn invalid_link() -> AppError {
    AppError::localized("shared_channel.link_invalid", "请选择两个未关联且使用已保存 API 密钥的普通配置，并填写渠道名称。此配置的鉴权或地址形式暂不支持关联。", "Select two unlinked configurations with stored API keys and enter a channel name. This authentication or endpoint configuration cannot be linked.")
}
fn stale_link() -> AppError {
    AppError::localized(
        "shared_channel.link_stale",
        "配置已变化或预览已过期，请重新预览后关联。",
        "Configuration changed or the preview expired. Preview the link again.",
    )
}
fn link_failed() -> AppError {
    AppError::localized(
        "shared_channel.link_failed",
        "未能保存关联，配置没有修改。请重试。",
        "Unable to save the link. No configurations were changed. Try again.",
    )
}

fn valid_request(request: &SharedChannelLinkRequest) -> bool {
    [
        &request.channel_id,
        &request.name,
        &request.claude_provider_id,
        &request.codex_provider_id,
    ]
    .into_iter()
    .all(|text| {
        !text.trim().is_empty() && text.len() <= 1024 && !text.chars().any(char::is_control)
    })
}

fn valid_url(text: &str) -> bool {
    url::Url::parse(text).is_ok_and(|url| {
        matches!(url.scheme(), "http" | "https")
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.fragment().is_none()
    })
}

fn managed(provider: &Provider, app: &AppType) -> bool {
    provider.category.as_deref() == Some("official")
        || provider.uses_managed_account_auth()
        || (*app == AppType::Codex && is_codex_official_provider(provider))
        || provider.meta.as_ref().is_some_and(|meta| {
            meta.github_account_id.is_some()
                || meta.auth_binding.as_ref().is_some_and(|binding| {
                    binding.source == crate::provider::AuthBindingSource::ManagedAccount
                })
        })
}

/// The supported subset has one stored, unambiguous key and one explicit URL.
/// Adapters verify that these are the credentials actually used by the proxy.
fn connection(provider: &Provider, app: &AppType) -> Result<Connection, ()> {
    let settings = &provider.settings_config;
    if !settings.is_object() || managed(provider, app) {
        return Err(());
    }
    let unsupported_root = [
        "apiKey",
        "api_key",
        "base_url",
        "baseUrl",
        "baseURL",
        "apiEndpoint",
        "http_headers",
        "env_http_headers",
        "apiKeyHelper",
    ];
    if unsupported_root
        .iter()
        .any(|key| settings.get(key).is_some())
    {
        return Err(());
    }
    if *app == AppType::Claude {
        let env = settings.get("env").and_then(Value::as_object).ok_or(())?;
        if [
            "OPENAI_API_KEY",
            "OPENROUTER_API_KEY",
            "GEMINI_API_KEY",
            "ANTHROPIC_CUSTOM_HEADERS",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_USE_VERTEX",
            "CLAUDE_CODE_USE_FOUNDRY",
        ]
        .iter()
        .any(|key| env.contains_key(*key))
        {
            return Err(());
        }
        let fields = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"];
        let present: Vec<_> = fields
            .into_iter()
            .filter(|key| env.contains_key(*key))
            .collect();
        if present.len() != 1 {
            return Err(());
        }
        let key_field = present[0];
        let key = env[key_field]
            .as_str()
            .filter(|key| !key.trim().is_empty() && !key.trim().starts_with('{'))
            .ok_or(())?;
        let url = env
            .get("ANTHROPIC_BASE_URL")
            .and_then(Value::as_str)
            .filter(|url| valid_url(url))
            .ok_or(())?;
        let adapter = ClaudeAdapter::new();
        let auth = adapter.extract_auth(provider).ok_or(())?;
        if !matches!(
            auth.strategy,
            AuthStrategy::Anthropic
                | AuthStrategy::ClaudeAuth
                | AuthStrategy::Bearer
                | AuthStrategy::Google
        ) || auth.api_key != key.trim()
            || adapter.extract_base_url(provider).map_err(|_| ())? != url.trim_end_matches('/')
        {
            return Err(());
        }
        let format = get_claude_api_format(provider);
        if provider
            .meta
            .as_ref()
            .and_then(|meta| meta.api_format.as_deref())
            .is_some_and(|format| {
                !UniversalProvider::supports_connection_format("anthropic", format)
            })
        {
            return Err(());
        }
        Ok(Connection {
            url: url.into(),
            key: key.trim().into(),
            format: format.into(),
            key_field: Some(key_field.into()),
            model: env
                .get("ANTHROPIC_MODEL")
                .and_then(Value::as_str)
                .map(str::to_string),
        })
    } else {
        if settings
            .get("env")
            .and_then(|env| env.get("OPENAI_API_KEY"))
            .is_some()
        {
            return Err(());
        }
        let auth = settings.get("auth").and_then(Value::as_object).ok_or(())?;
        if auth
            .keys()
            .any(|key| key != "OPENAI_API_KEY" && key != "auth_mode")
            || auth
                .get("auth_mode")
                .and_then(Value::as_str)
                .is_some_and(|mode| mode != "apikey" && mode != "api_key")
        {
            return Err(());
        }
        let key = auth
            .get("OPENAI_API_KEY")
            .and_then(Value::as_str)
            .filter(|key| !key.trim().is_empty())
            .ok_or(())?;
        let document = codex_document(provider).map_err(|_| ())?;
        if [
            "base_url",
            "experimental_bearer_token",
            "env_key",
            "http_headers",
            "env_http_headers",
            "wire_api",
        ]
        .iter()
        .any(|key| document.get(key).is_some())
        {
            return Err(());
        }
        let table = document
            .get("model_providers")
            .and_then(|providers| providers.get(codex_provider_id(&document)))
            .and_then(toml_edit::Item::as_table_like)
            .ok_or(())?;
        if [
            "experimental_bearer_token",
            "env_key",
            "http_headers",
            "env_http_headers",
        ]
        .iter()
        .any(|key| table.get(key).is_some())
        {
            return Err(());
        }
        if table
            .get("wire_api")
            .and_then(toml_edit::Item::as_str)
            .is_some_and(|format| {
                !matches!(
                    format,
                    "responses" | "chat" | "anthropic" | "openai_responses" | "openai_chat"
                )
            })
        {
            return Err(());
        }
        let url = table
            .get("base_url")
            .and_then(toml_edit::Item::as_str)
            .filter(|url| valid_url(url))
            .ok_or(())?;
        let adapter = CodexAdapter::new();
        let extracted = adapter.extract_auth(provider).ok_or(())?;
        if !matches!(
            extracted.strategy,
            AuthStrategy::Anthropic | AuthStrategy::Bearer
        ) || extracted.api_key != key.trim()
            || adapter.extract_base_url(provider).map_err(|_| ())? != url.trim_end_matches('/')
        {
            return Err(());
        }
        if provider
            .meta
            .as_ref()
            .and_then(|meta| meta.api_format.as_deref())
            .is_some_and(|format| {
                !UniversalProvider::supports_connection_format("openai_responses", format)
            })
        {
            return Err(());
        }
        let format = if should_convert_codex_responses_to_anthropic(provider, "/v1/responses") {
            "anthropic"
        } else if should_convert_codex_responses_to_chat(provider, "/v1/responses") {
            "openai_chat"
        } else {
            "openai_responses"
        };
        Ok(Connection {
            url: url.into(),
            key: key.trim().into(),
            format: format.into(),
            key_field: provider
                .meta
                .as_ref()
                .and_then(|meta| meta.api_key_field.clone()),
            model: document
                .get("model")
                .and_then(toml_edit::Item::as_str)
                .map(str::to_string),
        })
    }
}

fn reason(
    state: &AppState,
    provider: &Provider,
    app: &AppType,
    channels: &std::collections::HashMap<String, UniversalProvider>,
) -> Option<&'static str> {
    if provider
        .meta
        .as_ref()
        .is_some_and(|meta| meta.shared_channel_id.is_some())
        || provider
            .id
            .starts_with(&format!("universal-{}-", app.as_str()))
        || channels
            .values()
            .any(|channel| channel.child_id(app.as_str()) == provider.id)
    {
        Some("already_linked")
    } else if managed(provider, app) {
        Some("managed_auth")
    } else if connection(provider, app).is_err() || !common_connection_matches(state, provider, app)
    {
        Some("unsupported_config")
    } else {
        None
    }
}

// Common preferences can supply models, but a conflicting connection is not
// silently changed when adopting an ordinary configuration.
fn common_connection_matches(state: &AppState, provider: &Provider, app: &AppType) -> bool {
    let Ok(snippet) = state.db.get_config_snippet(app.as_str()) else {
        return false;
    };
    if !super::live::provider_uses_common_config(app, provider, snippet.as_deref()) {
        return true;
    }
    let Some(snippet) = snippet else {
        return true;
    };
    let Ok(settings) =
        super::live::apply_common_config_to_settings(app, &provider.settings_config, &snippet)
    else {
        return false;
    };
    let mut effective = provider.clone();
    effective.settings_config = settings;
    let (Ok(stored), Ok(effective)) = (connection(provider, app), connection(&effective, app))
    else {
        return false;
    };
    stored.url == effective.url
        && stored.key == effective.key
        && stored.format == effective.format
        && stored.key_field == effective.key_field
}

fn read_sources(
    state: &AppState,
    request: &SharedChannelLinkRequest,
) -> Result<[(String, Provider); 2], AppError> {
    let claude = state
        .db
        .get_provider_by_id(&request.claude_provider_id, "claude")
        .map_err(|_| invalid_link())?
        .ok_or_else(invalid_link)?;
    let codex = state
        .db
        .get_provider_by_id(&request.codex_provider_id, "codex")
        .map_err(|_| invalid_link())?
        .ok_or_else(invalid_link)?;
    Ok([("claude".into(), claude), ("codex".into(), codex)])
}

fn canonical(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let sorted: std::collections::BTreeMap<_, _> = map
                .into_iter()
                .map(|(key, value)| (key, canonical(value)))
                .collect();
            Value::Object(sorted.into_iter().collect())
        }
        Value::Array(values) => Value::Array(values.into_iter().map(canonical).collect()),
        other => other,
    }
}
fn proof_mac(
    request: &SharedChannelLinkRequest,
    expires: i64,
    original: Option<&[(String, Provider); 2]>,
) -> Result<Hmac<Sha256>, AppError> {
    let snapshot =
        canonical(serde_json::json!({"request":request,"expires":expires,"sources":original}));
    let mut mac = Hmac::<Sha256>::new_from_slice(&*PREVIEW_SECRET).map_err(|_| invalid_link())?;
    mac.update(&serde_json::to_vec(&snapshot).map_err(|_| invalid_link())?);
    Ok(mac)
}
fn proof(
    request: &SharedChannelLinkRequest,
    expires: i64,
    original: &[(String, Provider); 2],
) -> Result<String, AppError> {
    Ok(format!(
        "{expires}.{}.{}",
        URL_SAFE_NO_PAD.encode(proof_mac(request, expires, None)?.finalize().into_bytes()),
        URL_SAFE_NO_PAD.encode(
            proof_mac(request, expires, Some(original))?
                .finalize()
                .into_bytes()
        )
    ))
}
fn verify_proof(
    request: &SharedChannelLinkRequest,
    token: &str,
    original: Option<&[(String, Provider); 2]>,
) -> Result<(), AppError> {
    if token.len() > 128 {
        return Err(stale_link());
    }
    let parts: Vec<_> = token.split('.').collect();
    if parts.len() != 3 {
        return Err(stale_link());
    }
    let expires: i64 = parts[0].parse().map_err(|_| stale_link())?;
    let now = chrono::Utc::now().timestamp_millis();
    if (original.is_some() && expires < now) || expires > now + PREVIEW_TTL_MS {
        return Err(stale_link());
    }
    let signature = URL_SAFE_NO_PAD
        .decode(parts[if original.is_some() { 2 } else { 1 }])
        .map_err(|_| stale_link())?;
    proof_mac(request, expires, original)?
        .verify_slice(&signature)
        .map_err(|_| stale_link())
}

fn build_channel(
    request: &SharedChannelLinkRequest,
    sources: &[(String, Provider); 2],
) -> Result<UniversalProvider, AppError> {
    let claude = connection(&sources[0].1, &AppType::Claude).map_err(|_| invalid_link())?;
    let codex = connection(&sources[1].1, &AppType::Codex).map_err(|_| invalid_link())?;
    let key = match request.key_source {
        LinkKeySource::Claude => &claude.key,
        LinkKeySource::Codex => &codex.key,
    };
    let mut channel = UniversalProvider::new(
        request.channel_id.clone(),
        request.name.trim().into(),
        "custom".into(),
        claude.url.clone(),
        key.clone(),
    );
    channel.apps.claude = true;
    channel.apps.codex = true;
    channel
        .child_ids
        .insert("claude".into(), request.claude_provider_id.clone());
    channel
        .child_ids
        .insert("codex".into(), request.codex_provider_id.clone());
    channel.connections.claude = Some(SharedChannelConnection {
        base_url: Some(claude.url),
        api_format: Some(claude.format),
        api_key_field: claude.key_field,
        requires_openai_auth: None,
    });
    channel.connections.codex = Some(SharedChannelConnection {
        base_url: Some(codex.url),
        api_format: Some(codex.format),
        api_key_field: codex.key_field,
        requires_openai_auth: {
            let document = codex_document(&sources[1].1)?;
            document
                .get("model_providers")
                .and_then(|providers| providers.get(codex_provider_id(&document)))
                .and_then(|provider| provider.get("requires_openai_auth"))
                .and_then(toml_edit::Item::as_bool)
        },
    });
    let env = &sources[0].1.settings_config["env"];
    channel.models.claude = Some(ClaudeModelConfig {
        model: claude.model,
        haiku_model: env
            .get("ANTHROPIC_DEFAULT_HAIKU_MODEL")
            .and_then(Value::as_str)
            .map(str::to_string),
        sonnet_model: env
            .get("ANTHROPIC_DEFAULT_SONNET_MODEL")
            .and_then(Value::as_str)
            .map(str::to_string),
        opus_model: env
            .get("ANTHROPIC_DEFAULT_OPUS_MODEL")
            .and_then(Value::as_str)
            .map(str::to_string),
    });
    let document = codex_document(&sources[1].1)?;
    channel.models.codex = Some(CodexModelConfig {
        model: codex.model,
        reasoning_effort: document
            .get("model_reasoning_effort")
            .and_then(toml_edit::Item::as_str)
            .map(str::to_string),
    });
    validate(&channel)?;
    Ok(channel)
}

fn matches_committed(
    channel: &UniversalProvider,
    request: &SharedChannelLinkRequest,
    sources: &[(String, Provider); 2],
) -> bool {
    channel.child_ids.get("claude") == Some(&request.claude_provider_id)
        && channel.child_ids.get("codex") == Some(&request.codex_provider_id)
        && sources.iter().all(|(_, provider)| {
            provider
                .meta
                .as_ref()
                .and_then(|meta| meta.shared_channel_id.as_deref())
                == Some(&request.channel_id)
        })
}

impl ProviderService {
    pub fn list_shared_channel_link_candidates(
        state: &AppState,
    ) -> Result<SharedChannelLinkCandidates, AppError> {
        let channels = state
            .db
            .get_all_universal_providers()
            .map_err(|_| invalid_link())?;
        let list = |app: AppType| -> Result<_, AppError> {
            Ok(state
                .db
                .get_all_providers(app.as_str())
                .map_err(|_| invalid_link())?
                .into_values()
                .map(|provider| {
                    let reason = reason(state, &provider, &app, &channels);
                    SharedChannelLinkCandidate {
                        id: provider.id,
                        name: provider.name,
                        eligible: reason.is_none(),
                        reason,
                    }
                })
                .collect())
        };
        Ok(SharedChannelLinkCandidates {
            claude: list(AppType::Claude)?,
            codex: list(AppType::Codex)?,
        })
    }

    pub fn preview_shared_channel_link(
        state: &AppState,
        request: SharedChannelLinkRequest,
    ) -> Result<SharedChannelLinkPreview, AppError> {
        if !valid_request(&request) {
            return Err(invalid_link());
        }
        let _claude =
            futures::executor::block_on(state.proxy_service.lock_switch_for_app("claude"));
        let _codex = futures::executor::block_on(state.proxy_service.lock_switch_for_app("codex"));
        let channels = state
            .db
            .get_all_universal_providers()
            .map_err(|_| invalid_link())?;
        let sources = read_sources(state, &request)?;
        let already_committed = channels
            .get(&request.channel_id)
            .is_some_and(|channel| matches_committed(channel, &request, &sources));
        if channels.contains_key(&request.channel_id) && !already_committed {
            return Err(invalid_link());
        }
        let mut apps = Vec::new();
        for ((_, provider), app) in sources.iter().zip([AppType::Claude, AppType::Codex]) {
            if !already_committed && reason(state, provider, &app, &channels).is_some() {
                return Err(invalid_link());
            }
            let connection = connection(provider, &app).map_err(|_| invalid_link())?;
            let mut url = url::Url::parse(&connection.url).map_err(|_| invalid_link())?;
            if url.query().is_some() {
                url.set_query(Some("[REDACTED]"));
            }
            apps.push(SharedChannelLinkAppPreview {
                app: app.as_str().into(),
                provider_id: provider.id.clone(),
                name: provider.name.clone(),
                base_url: url.into(),
                api_format: connection.format,
                model: connection.model,
                current: crate::settings::get_effective_current_provider(&state.db, &app)
                    .map_err(|_| invalid_link())?
                    .as_deref()
                    == Some(&provider.id),
            });
        }
        let claude = connection(&sources[0].1, &AppType::Claude).map_err(|_| invalid_link())?;
        let codex = connection(&sources[1].1, &AppType::Codex).map_err(|_| invalid_link())?;
        let expires_at = chrono::Utc::now().timestamp_millis() + PREVIEW_TTL_MS;
        Ok(SharedChannelLinkPreview {
            token: proof(&request, expires_at, &sources)?,
            credentials_differ: claude.key != codex.key,
            key_source: request.key_source,
            apps,
            expires_at,
        })
    }

    pub fn link_existing_shared_channel(
        state: &AppState,
        request: SharedChannelLinkRequest,
        token: String,
    ) -> Result<SharedChannelLinkResult, AppError> {
        if !valid_request(&request) {
            return Err(invalid_link());
        }
        verify_proof(&request, &token, None)?;
        let _claude =
            futures::executor::block_on(state.proxy_service.lock_switch_for_app("claude"));
        let _codex = futures::executor::block_on(state.proxy_service.lock_switch_for_app("codex"));
        let _gemini =
            futures::executor::block_on(state.proxy_service.lock_switch_for_app("gemini"));
        let sources = read_sources(state, &request).map_err(|_| stale_link())?;
        let channels = state
            .db
            .get_all_universal_providers()
            .map_err(|_| stale_link())?;
        if let Some(existing) = channels.get(&request.channel_id) {
            if !matches_committed(existing, &request, &sources) {
                return Err(stale_link());
            }
            // An acknowledged or lost reply may be retried. Project the latest
            // stored children; never reapply the preview's old key or models.
            return Ok(SharedChannelLinkResult {
                channel_id: request.channel_id,
                result: Self::project_shared_children(state, sources.into())?,
            });
        }
        verify_proof(&request, &token, Some(&sources))?;
        if sources
            .iter()
            .zip([AppType::Claude, AppType::Codex])
            .any(|((_, provider), app)| reason(state, provider, &app, &channels).is_some())
        {
            return Err(stale_link());
        }
        let channel = build_channel(&request, &sources)?;
        let mut children = Vec::new();
        for ((app_name, original), app) in sources.iter().zip([AppType::Claude, AppType::Codex]) {
            let generated = child(&channel, &app).ok_or_else(invalid_link)?;
            let merged = merge_child(
                &app,
                generated.clone(),
                Some(generated),
                Some(original.clone()),
            )?;
            Self::validate_provider_settings(&app, &merged).map_err(|_| invalid_link())?;
            children.push((app_name.clone(), merged));
        }
        state
            .db
            .link_shared_channel_children(&channel, &sources, &children)
            .map_err(|_| link_failed())?;
        Ok(SharedChannelLinkResult {
            channel_id: request.channel_id,
            result: Self::project_shared_children(state, children)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use serial_test::serial;

    fn with_home(test: impl FnOnce(&AppState, &std::path::Path)) {
        super::super::tests::with_test_home(|state, home| {
            crate::settings::reload_settings().unwrap();
            test(state, home);
        });
    }
    fn request() -> SharedChannelLinkRequest {
        SharedChannelLinkRequest {
            channel_id: "synthetic-linked".into(),
            name: "Shared synthetic channel".into(),
            claude_provider_id: "old-claude".into(),
            codex_provider_id: "old-codex".into(),
            key_source: LinkKeySource::Claude,
        }
    }
    fn seed(state: &AppState, key_field: &str) -> [Provider; 2] {
        let mut claude = Provider::with_id(
            "old-claude".into(),
            "My Claude name".into(),
            json!({"env":{"ANTHROPIC_BASE_URL":"https://claude.synthetic.example/messages?secret=fake-query-secret",key_field:"fake-claude-key","PREFERENCE":"keep"},"permissions":{"allow":["synthetic-command"]}}),
            Some("https://claude.synthetic.example/about".into()),
        );
        claude.notes = Some("private-notes".into());
        claude.icon = Some("claude".into());
        claude.in_failover_queue = true;
        claude.meta = Some(crate::provider::ProviderMeta {
            is_full_url: Some(true),
            limit_daily_usd: Some("7".into()),
            ..Default::default()
        });
        let codex = Provider::with_id(
            "old-codex".into(),
            "My Codex name".into(),
            json!({"auth":{"OPENAI_API_KEY":"fake-codex-key"},"config":"model_provider = 'vendor'\napproval_policy = 'never'\n[model_providers.vendor]\nname = 'Original vendor'\nbase_url = 'https://codex.synthetic.example'\nwire_api = 'responses'\nrequires_openai_auth = true\n[mcp_servers.synthetic]\ncommand = 'keep-command'\nargs = ['private-tool-arg']\n"}),
            None,
        );
        state.db.save_provider("claude", &claude).unwrap();
        state.db.save_provider("codex", &codex).unwrap();
        [claude, codex]
    }
    fn link(state: &AppState, request: SharedChannelLinkRequest) -> SharedChannelLinkResult {
        let preview = ProviderService::preview_shared_channel_link(state, request.clone()).unwrap();
        ProviderService::link_existing_shared_channel(state, request, preview.token).unwrap()
    }

    #[test]
    #[serial]
    fn shared_channel_link_preview_is_whitelisted_and_does_not_write() {
        with_home(|state, _| {
            let original = seed(state, "ANTHROPIC_AUTH_TOKEN");
            let candidates = ProviderService::list_shared_channel_link_candidates(state).unwrap();
            assert!(candidates.claude[0].eligible && candidates.codex[0].eligible);
            let preview = ProviderService::preview_shared_channel_link(state, request()).unwrap();
            assert!(preview.credentials_differ);
            let text = serde_json::to_string(&preview).unwrap();
            let candidates = serde_json::to_string(&candidates).unwrap();
            for secret in [
                "fake-claude-key",
                "fake-codex-key",
                "fake-query-secret",
                "private-notes",
                "private-tool-arg",
                "settingsConfig",
            ] {
                assert!(!text.contains(secret));
                assert!(!candidates.contains(secret));
            }
            assert!(state.db.get_all_universal_providers().unwrap().is_empty());
            for (app, original) in ["claude", "codex"].into_iter().zip(original) {
                assert_eq!(
                    state
                        .db
                        .get_provider_by_id(&original.id, app)
                        .unwrap()
                        .unwrap()
                        .settings_config,
                    original.settings_config
                );
            }
        });
    }

    #[test]
    #[serial]
    fn shared_channel_link_preserves_identity_models_options_and_references() {
        with_home(|state, _| {
            let originals = seed(state, "ANTHROPIC_API_KEY");
            let group = state
                .db
                .create_routing_group("claude", "Synthetic group", None)
                .unwrap();
            state
                .db
                .set_routing_group_members(&group.id, &["old-claude".into()])
                .unwrap();
            state
                .db
                .upsert_model_alias("codex", "alias", "old-codex", "model-custom", None, None)
                .unwrap();
            state.db.set_current_provider("codex", "old-codex").unwrap();
            let result = link(state, request());
            assert!(result.result.failed_apps.is_empty());
            let mut channel = state
                .db
                .get_universal_provider("synthetic-linked")
                .unwrap()
                .unwrap();
            assert_eq!(channel.child_id("claude"), "old-claude");
            channel.name = "New parent name".into();
            channel.api_key = "fake-rotated-key".into();
            ProviderService::save_shared_channel(state, channel).unwrap();
            for (app, original) in ["claude", "codex"].into_iter().zip(originals) {
                let providers = state.db.get_all_providers(app).unwrap();
                assert_eq!(providers.len(), 1);
                let actual = &providers[&original.id];
                assert_eq!(actual.name, original.name);
                assert_eq!(actual.notes, original.notes);
                assert_eq!(actual.icon, original.icon);
                assert_eq!(actual.website_url, original.website_url);
                if app == "claude" {
                    assert!(actual.in_failover_queue);
                    assert_eq!(
                        actual.settings_config["env"]["ANTHROPIC_API_KEY"],
                        "fake-rotated-key"
                    );
                    assert!(actual.settings_config["env"]
                        .get("ANTHROPIC_MODEL")
                        .is_none());
                    assert!(actual.settings_config["env"]
                        .get("ANTHROPIC_AUTH_TOKEN")
                        .is_none());
                    assert_eq!(
                        actual.settings_config["permissions"],
                        original.settings_config["permissions"]
                    );
                    assert_eq!(actual.meta.as_ref().unwrap().is_full_url, Some(true));
                    assert_eq!(
                        actual.meta.as_ref().unwrap().limit_daily_usd.as_deref(),
                        Some("7")
                    );
                    assert_eq!(
                        ClaudeAdapter::new().extract_auth(actual).unwrap().strategy,
                        AuthStrategy::Anthropic
                    );
                } else {
                    let document = codex_document(actual).unwrap();
                    assert!(document.get("model").is_none());
                    assert!(document.get("model_reasoning_effort").is_none());
                    assert_eq!(
                        document["model_providers"]["vendor"]["base_url"].as_str(),
                        Some("https://codex.synthetic.example")
                    );
                    assert_eq!(
                        document["model_providers"]["vendor"]["name"].as_str(),
                        Some("Original vendor")
                    );
                    assert_eq!(
                        document["mcp_servers"]["synthetic"]["command"].as_str(),
                        Some("keep-command")
                    );
                    assert_eq!(
                        actual.settings_config["auth"]["OPENAI_API_KEY"],
                        "fake-rotated-key"
                    );
                }
            }
            assert_eq!(
                state.db.get_current_provider("codex").unwrap().as_deref(),
                Some("old-codex")
            );
            assert_eq!(
                state.db.list_model_aliases("codex").unwrap()[0].provider_id,
                "old-codex"
            );
            let conn = state.db.conn.lock().unwrap();
            let member: String = conn
                .query_row(
                    "SELECT provider_id FROM routing_group_members WHERE group_id = ?1",
                    [&group.id],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(member, "old-claude");
        });
    }

    #[test]
    #[serial]
    fn shared_channel_link_key_source_and_idempotence_use_latest_values() {
        with_home(|state, _| {
            seed(state, "ANTHROPIC_AUTH_TOKEN");
            let mut request = request();
            request.key_source = LinkKeySource::Codex;
            let preview =
                ProviderService::preview_shared_channel_link(state, request.clone()).unwrap();
            ProviderService::link_existing_shared_channel(
                state,
                request.clone(),
                preview.token.clone(),
            )
            .unwrap();
            let mut channel = state
                .db
                .get_universal_provider(&request.channel_id)
                .unwrap()
                .unwrap();
            assert_eq!(channel.api_key, "fake-codex-key");
            channel.api_key = "fake-latest-key".into();
            ProviderService::save_shared_channel(state, channel).unwrap();
            ProviderService::link_existing_shared_channel(state, request, preview.token).unwrap();
            assert_eq!(state.db.get_all_universal_providers().unwrap().len(), 1);
            assert_eq!(
                state
                    .db
                    .get_provider_by_id("old-claude", "claude")
                    .unwrap()
                    .unwrap()
                    .settings_config["env"]["ANTHROPIC_AUTH_TOKEN"],
                "fake-latest-key"
            );
        });
    }

    #[test]
    #[serial]
    fn shared_channel_link_stale_expired_tampered_proofs_reject_without_writes() {
        with_home(|state, _| {
            seed(state, "ANTHROPIC_AUTH_TOKEN");
            for change in ["key", "model", "name", "delete"] {
                let preview =
                    ProviderService::preview_shared_channel_link(state, request()).unwrap();
                let mut original = state
                    .db
                    .get_provider_by_id("old-codex", "codex")
                    .unwrap()
                    .unwrap();
                match change {
                    "key" => {
                        original.settings_config["auth"]["OPENAI_API_KEY"] = "fake-changed".into()
                    }
                    "model" => {
                        original.settings_config["config"] = format!(
                            "model = 'new-model'\n{}",
                            original.settings_config["config"].as_str().unwrap()
                        )
                        .into()
                    }
                    "name" => original.name = "Changed name".into(),
                    _ => {}
                }
                if change == "delete" {
                    state.db.delete_provider("codex", "old-codex").unwrap();
                } else {
                    state.db.save_provider("codex", &original).unwrap();
                }
                assert!(ProviderService::link_existing_shared_channel(
                    state,
                    request(),
                    preview.token
                )
                .is_err());
                assert!(state.db.get_all_universal_providers().unwrap().is_empty());
                seed(state, "ANTHROPIC_AUTH_TOKEN");
            }
            let sources = read_sources(state, &request()).unwrap();
            let expired = proof(
                &request(),
                chrono::Utc::now().timestamp_millis() - 1,
                &sources,
            )
            .unwrap();
            assert!(
                ProviderService::link_existing_shared_channel(state, request(), expired).is_err()
            );
            let preview = ProviderService::preview_shared_channel_link(state, request()).unwrap();
            let mut changed = request();
            changed.key_source = LinkKeySource::Codex;
            assert!(
                ProviderService::link_existing_shared_channel(state, changed, preview.token)
                    .is_err()
            );
        });
    }

    #[test]
    #[serial]
    fn shared_channel_link_rejects_ambiguous_managed_and_bound_candidates() {
        with_home(|state, _| {
            let [claude, codex] = seed(state, "ANTHROPIC_AUTH_TOKEN");
            let channels = state.db.get_all_universal_providers().unwrap();
            let mut dual = claude.clone();
            dual.settings_config["env"]["ANTHROPIC_API_KEY"] = "fake-other".into();
            assert_eq!(
                reason(state, &dual, &AppType::Claude, &channels),
                Some("unsupported_config")
            );
            let mut oauth = claude.clone();
            oauth.meta.as_mut().unwrap().provider_type = Some("codex_oauth".into());
            assert_eq!(
                reason(state, &oauth, &AppType::Claude, &channels),
                Some("managed_auth")
            );
            for field in [
                "env_key = 'SYNTHETIC_ENV'",
                "experimental_bearer_token = 'fake-bearer'",
                "http_headers = { Authorization = 'fake-header' }",
            ] {
                let mut unsupported = codex.clone();
                unsupported.settings_config["config"] = format!("model_provider = 'vendor'\n[model_providers.vendor]\nbase_url = 'https://synthetic.example'\n{field}\n").into();
                assert_eq!(
                    reason(state, &unsupported, &AppType::Codex, &channels),
                    Some("unsupported_config")
                );
            }
            let mut mixed = codex;
            mixed.settings_config["auth"]["tokens"] = json!({"access_token":"fake-oauth"});
            assert!(reason(state, &mixed, &AppType::Codex, &channels).is_some());
            link(state, request());
            let candidates = ProviderService::list_shared_channel_link_candidates(state).unwrap();
            assert_eq!(candidates.claude[0].reason, Some("already_linked"));
            assert_eq!(candidates.codex[0].reason, Some("already_linked"));
        });
    }

    #[test]
    #[serial]
    fn shared_channel_link_transaction_rolls_back_on_second_write_and_cas_conflict() {
        with_home(|state, _| {
            seed(state, "ANTHROPIC_AUTH_TOKEN");
            let preview = ProviderService::preview_shared_channel_link(state, request()).unwrap();
            state.db.conn.lock().unwrap().execute_batch("CREATE TRIGGER fail_link_codex BEFORE UPDATE ON providers WHEN NEW.app_type = 'codex' BEGIN SELECT RAISE(ABORT, 'fake-secret-error'); END;").unwrap();
            let error =
                ProviderService::link_existing_shared_channel(state, request(), preview.token)
                    .err()
                    .unwrap()
                    .to_string();
            assert!(!error.contains("fake-secret-error"));
            assert!(state.db.get_all_universal_providers().unwrap().is_empty());
            assert!(state
                .db
                .get_provider_by_id("old-claude", "claude")
                .unwrap()
                .unwrap()
                .meta
                .unwrap()
                .shared_channel_id
                .is_none());
            state
                .db
                .conn
                .lock()
                .unwrap()
                .execute_batch("DROP TRIGGER fail_link_codex")
                .unwrap();
            let sources = read_sources(state, &request()).unwrap();
            let channel = build_channel(&request(), &sources).unwrap();
            let mut changed = sources[0].1.clone();
            changed.notes = Some("changed after read".into());
            state.db.save_provider("claude", &changed).unwrap();
            assert!(state
                .db
                .link_shared_channel_children(&channel, &sources, &[])
                .is_err());
            assert!(state.db.get_all_universal_providers().unwrap().is_empty());
        });
    }

    #[test]
    #[serial]
    fn shared_channel_link_unlinks_without_deleting_current_or_referenced_originals() {
        with_home(|state, _| {
            seed(state, "ANTHROPIC_AUTH_TOKEN");
            link(state, request());
            state
                .db
                .set_current_provider("claude", "old-claude")
                .unwrap();
            crate::settings::set_current_provider(&AppType::Claude, Some("old-claude")).unwrap();
            state
                .db
                .upsert_model_alias("claude", "alias", "old-claude", "model", None, None)
                .unwrap();
            let mut channel = state
                .db
                .get_universal_provider("synthetic-linked")
                .unwrap()
                .unwrap();
            channel.apps.claude = false;
            ProviderService::save_shared_channel(state, channel).unwrap();
            let channel = state
                .db
                .get_universal_provider("synthetic-linked")
                .unwrap()
                .unwrap();
            assert!(!channel.child_ids.contains_key("claude"));
            assert!(state
                .db
                .get_provider_by_id("old-claude", "claude")
                .unwrap()
                .unwrap()
                .meta
                .unwrap()
                .shared_channel_id
                .is_none());
            assert!(ProviderService::delete_universal(state, &channel.id).unwrap());
            assert!(state
                .db
                .get_provider_by_id("old-codex", "codex")
                .unwrap()
                .unwrap()
                .meta
                .unwrap()
                .shared_channel_id
                .is_none());
            assert_eq!(
                state.db.get_current_provider("claude").unwrap().as_deref(),
                Some("old-claude")
            );
            assert_eq!(state.db.list_model_aliases("claude").unwrap().len(), 1);
        });
    }

    #[test]
    #[serial]
    fn shared_channel_link_custom_ids_obey_edit_add_delete_and_mapping_guards() {
        with_home(|state, _| {
            seed(state, "ANTHROPIC_API_KEY");
            let stale_claude = state
                .db
                .get_provider_by_id("old-claude", "claude")
                .unwrap()
                .unwrap();
            link(state, request());
            let mut editable = state
                .db
                .get_provider_by_id("old-claude", "claude")
                .unwrap()
                .unwrap();
            editable.notes = Some("Independent edit".into());
            ProviderService::update(state, AppType::Claude, None, editable.clone()).unwrap();
            editable.settings_config["env"]["ANTHROPIC_API_KEY"] = "fake-forged".into();
            assert!(ProviderService::update(state, AppType::Claude, None, editable).is_err());
            assert!(ProviderService::add(state, AppType::Claude, stale_claude, false).is_err());
            assert!(ProviderService::delete(state, AppType::Claude, "old-claude").is_err());
            let mut channel = state
                .db
                .get_universal_provider("synthetic-linked")
                .unwrap()
                .unwrap();
            channel
                .child_ids
                .insert("claude".into(), "unrelated".into());
            assert!(ProviderService::save_shared_channel(state, channel.clone()).is_err());
            channel.id = "forged-channel".into();
            assert!(ProviderService::save_shared_channel(state, channel).is_err());
            let mut copied = state
                .db
                .get_universal_provider("synthetic-linked")
                .unwrap()
                .unwrap();
            copied.id = "copied-channel".into();
            copied.child_ids.clear();
            ProviderService::save_shared_channel(state, copied).unwrap();
            assert!(state
                .db
                .get_provider_by_id("universal-claude-copied-channel", "claude")
                .unwrap()
                .is_some());
            assert_eq!(
                state
                    .db
                    .get_provider_by_id("old-claude", "claude")
                    .unwrap()
                    .unwrap()
                    .name,
                "My Claude name"
            );
        });
    }

    #[test]
    #[serial]
    fn shared_channel_link_partial_projection_is_saved_and_resynced_by_id() {
        with_home(|state, _| {
            seed(state, "ANTHROPIC_AUTH_TOKEN");
            state
                .db
                .set_current_provider("claude", "old-claude")
                .unwrap();
            let path = crate::config::get_claude_settings_path();
            std::fs::create_dir_all(&path).unwrap();
            let result = link(state, request());
            assert_eq!(result.result.failed_apps, ["claude"]);
            assert_eq!(result.channel_id, "synthetic-linked");
            std::fs::remove_dir(&path).unwrap();
            let result = ProviderService::resync_shared_channel(state, "synthetic-linked").unwrap();
            assert!(result.failed_apps.is_empty());
            assert_eq!(state.db.get_all_universal_providers().unwrap().len(), 1);
        });
    }

    #[test]
    #[serial]
    fn shared_channel_link_preserves_codex_auth_flag_and_recovers_lost_acknowledgement() {
        with_home(|state, _| {
            seed(state, "ANTHROPIC_AUTH_TOKEN");
            let mut codex = state
                .db
                .get_provider_by_id("old-codex", "codex")
                .unwrap()
                .unwrap();
            codex.settings_config["config"] = codex.settings_config["config"]
                .as_str()
                .unwrap()
                .replace(
                    "requires_openai_auth = true",
                    "requires_openai_auth = false",
                )
                .into();
            state.db.save_provider("codex", &codex).unwrap();
            let sources = read_sources(state, &request()).unwrap();
            let expired = proof(
                &request(),
                chrono::Utc::now().timestamp_millis() - 1,
                &sources,
            )
            .unwrap();
            link(state, request());
            let retry = ProviderService::preview_shared_channel_link(state, request()).unwrap();
            assert!(!retry.credentials_differ);
            ProviderService::link_existing_shared_channel(state, request(), retry.token).unwrap();
            ProviderService::link_existing_shared_channel(state, request(), expired).unwrap();
            let codex = state
                .db
                .get_provider_by_id("old-codex", "codex")
                .unwrap()
                .unwrap();
            assert_eq!(
                codex_document(&codex).unwrap()["model_providers"]["vendor"]
                    ["requires_openai_auth"]
                    .as_bool(),
                Some(false)
            );
            assert_eq!(state.db.get_all_universal_providers().unwrap().len(), 1);
        });
    }

    #[test]
    #[serial]
    fn shared_channel_link_common_models_remain_inherited_and_conflicting_keys_are_rejected() {
        with_home(|state, _| {
            seed(state, "ANTHROPIC_API_KEY");
            let mut claude = state
                .db
                .get_provider_by_id("old-claude", "claude")
                .unwrap()
                .unwrap();
            claude.meta.as_mut().unwrap().common_config_enabled = Some(true);
            state.db.save_provider("claude", &claude).unwrap();
            state
                .db
                .set_config_snippet(
                    "claude",
                    Some(json!({"env":{"ANTHROPIC_API_KEY":"fake-conflicting"}}).to_string()),
                )
                .unwrap();
            assert!(
                !ProviderService::list_shared_channel_link_candidates(state)
                    .unwrap()
                    .claude[0]
                    .eligible
            );
            state
                .db
                .set_config_snippet(
                    "claude",
                    Some(json!({"env":{"ANTHROPIC_MODEL":"inherited-model"}}).to_string()),
                )
                .unwrap();
            assert!(
                ProviderService::list_shared_channel_link_candidates(state)
                    .unwrap()
                    .claude[0]
                    .eligible
            );
            link(state, request());
            let stored = state
                .db
                .get_provider_by_id("old-claude", "claude")
                .unwrap()
                .unwrap();
            assert!(stored.settings_config["env"]
                .get("ANTHROPIC_MODEL")
                .is_none());
            let effective = super::super::live::build_effective_settings_with_common_config(
                &state.db,
                &AppType::Claude,
                &stored,
            )
            .unwrap();
            assert_eq!(effective["env"]["ANTHROPIC_MODEL"], "inherited-model");
            assert_eq!(effective["env"]["ANTHROPIC_API_KEY"], "fake-claude-key");
        });
    }

    #[test]
    #[serial]
    fn shared_channel_link_reorder_writes_only_sort_column_after_stale_snapshot() {
        with_home(|state, _| {
            seed(state, "ANTHROPIC_AUTH_TOKEN");
            let before = state.db.get_all_providers("claude").unwrap();
            let pending_order = vec![super::super::ProviderSortUpdate {
                id: before["old-claude"].id.clone(),
                sort_index: 17,
            }];
            link(state, request());
            let mut channel = state
                .db
                .get_universal_provider("synthetic-linked")
                .unwrap()
                .unwrap();
            channel.api_key = "fake-rotated-before-sort".into();
            ProviderService::save_shared_channel(state, channel).unwrap();
            // Fail even an otherwise identical whole-row write. Sorting owns
            // only sort_index, so it must not write secret or binding columns.
            state.db.conn.lock().unwrap().execute_batch("CREATE TRIGGER no_sort_connection_write BEFORE UPDATE OF settings_config, meta ON providers BEGIN SELECT RAISE(ABORT, 'sort rewrote protected columns'); END;").unwrap();
            ProviderService::update_sort_order(state, AppType::Claude, pending_order).unwrap();
            let child = state
                .db
                .get_provider_by_id("old-claude", "claude")
                .unwrap()
                .unwrap();
            assert_eq!(child.sort_index, Some(17));
            assert_eq!(
                child.meta.unwrap().shared_channel_id.as_deref(),
                Some("synthetic-linked")
            );
            assert_eq!(
                child.settings_config["env"]["ANTHROPIC_AUTH_TOKEN"],
                "fake-rotated-before-sort"
            );
        });
    }

    #[test]
    #[serial]
    fn shared_channel_link_auxiliary_writers_read_after_waiting_for_rotation_lock() {
        with_home(|state, _| {
            seed(state, "ANTHROPIC_AUTH_TOKEN");
            state
                .db
                .add_custom_endpoint("claude", "old-claude", "https://endpoint.synthetic.example")
                .unwrap();
            let preview = ProviderService::preview_shared_channel_link(state, request()).unwrap();
            let sources = read_sources(state, &request()).unwrap();
            let mut channel = build_channel(&request(), &sources).unwrap();
            channel.api_key = "fake-latest-under-lock".into();
            let children: Vec<_> = sources
                .iter()
                .zip([AppType::Claude, AppType::Codex])
                .map(|((app_name, original), app)| {
                    let generated = child(&channel, &app).unwrap();
                    (
                        app_name.clone(),
                        merge_child(
                            &app,
                            generated.clone(),
                            Some(generated),
                            Some(original.clone()),
                        )
                        .unwrap(),
                    )
                })
                .collect();
            std::thread::scope(|scope| {
                let guard =
                    futures::executor::block_on(state.proxy_service.lock_switch_for_app("claude"));
                let (endpoint_tx, endpoint_rx) = std::sync::mpsc::channel();
                let (migration_tx, migration_rx) = std::sync::mpsc::channel();
                let endpoint = scope.spawn(move || {
                    let result = ProviderService::update_endpoint_last_used(
                        state,
                        AppType::Claude,
                        "old-claude",
                        "https://endpoint.synthetic.example".into(),
                    );
                    endpoint_tx.send(result.is_ok()).unwrap();
                });
                let migration = scope.spawn(move || {
                    let result = ProviderService::migrate_legacy_common_config_usage(
                        state,
                        AppType::Claude,
                        &json!({"env":{"PREFERENCE":"keep"}}).to_string(),
                    );
                    migration_tx.send(result.is_ok()).unwrap();
                });
                assert!(matches!(
                    endpoint_rx.recv_timeout(std::time::Duration::from_millis(50)),
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout)
                ));
                assert!(matches!(
                    migration_rx.recv_timeout(std::time::Duration::from_millis(50)),
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout)
                ));
                // Complete adoption and key rotation while both writers wait.
                state
                    .db
                    .link_shared_channel_children(&channel, &sources, &children)
                    .unwrap();
                drop(guard);
                assert!(endpoint_rx
                    .recv_timeout(std::time::Duration::from_secs(5))
                    .unwrap());
                assert!(migration_rx
                    .recv_timeout(std::time::Duration::from_secs(5))
                    .unwrap());
                endpoint.join().unwrap();
                migration.join().unwrap();
            });
            let child = state
                .db
                .get_provider_by_id("old-claude", "claude")
                .unwrap()
                .unwrap();
            assert_eq!(
                child.meta.as_ref().unwrap().shared_channel_id.as_deref(),
                Some("synthetic-linked")
            );
            assert_eq!(
                child.meta.as_ref().unwrap().common_config_enabled,
                Some(true)
            );
            assert_eq!(
                child.settings_config["env"]["ANTHROPIC_AUTH_TOKEN"],
                "fake-latest-under-lock"
            );
            assert!(child.settings_config["env"].get("PREFERENCE").is_none());
            // The pending acknowledged operation still projects latest rows.
            ProviderService::link_existing_shared_channel(state, request(), preview.token).unwrap();
        });
    }

    #[test]
    #[serial]
    fn shared_channel_link_detach_partial_projection_resync_uses_committed_mapping() {
        with_home(|state, _| {
            seed(state, "ANTHROPIC_AUTH_TOKEN");
            link(state, request());
            state.db.set_current_provider("codex", "old-codex").unwrap();
            let path = crate::codex_config::get_codex_config_path();
            std::fs::create_dir_all(&path).unwrap();
            let mut channel = state
                .db
                .get_universal_provider("synthetic-linked")
                .unwrap()
                .unwrap();
            channel.apps.claude = false;
            let result = ProviderService::save_shared_channel(state, channel.clone()).unwrap();
            assert_eq!(result.failed_apps, ["codex"]);
            assert!(!state
                .db
                .get_universal_provider("synthetic-linked")
                .unwrap()
                .unwrap()
                .child_ids
                .contains_key("claude"));
            assert!(ProviderService::save_shared_channel(state, channel).is_err());
            std::fs::remove_dir(&path).unwrap();
            assert!(
                ProviderService::resync_shared_channel(state, "synthetic-linked")
                    .unwrap()
                    .failed_apps
                    .is_empty()
            );
            let original = state
                .db
                .get_provider_by_id("old-claude", "claude")
                .unwrap()
                .unwrap();
            assert!(original.meta.unwrap().shared_channel_id.is_none());
            assert!(state
                .db
                .get_provider_by_id("universal-claude-synthetic-linked", "claude")
                .unwrap()
                .is_none());
            assert_eq!(state.db.get_all_providers("codex").unwrap().len(), 1);
        });
    }

    #[test]
    #[serial]
    fn shared_channel_link_proxy_backup_rotation_and_stop_keep_original_id() {
        with_home(|state, _| {
            seed(state, "ANTHROPIC_API_KEY");
            link(state, request());
            ProviderService::switch(state, AppType::Codex, "old-codex").unwrap();
            let provider = state
                .db
                .get_provider_by_id("old-codex", "codex")
                .unwrap()
                .unwrap();
            futures::executor::block_on(
                state
                    .db
                    .save_live_backup("codex", &provider.settings_config.to_string()),
            )
            .unwrap();
            let path = crate::codex_config::get_codex_config_path();
            let mut live: toml_edit::DocumentMut =
                std::fs::read_to_string(&path).unwrap().parse().unwrap();
            live["model_providers"]["vendor"]["base_url"] =
                toml_edit::value("http://127.0.0.1:15731/v1");
            live["model_providers"]["vendor"]["experimental_bearer_token"] =
                toml_edit::value("PROXY_MANAGED");
            std::fs::write(&path, live.to_string()).unwrap();
            let mut channel = state
                .db
                .get_universal_provider("synthetic-linked")
                .unwrap()
                .unwrap();
            channel.api_key = "fake-rotated-under-proxy".into();
            assert!(ProviderService::save_shared_channel(state, channel)
                .unwrap()
                .failed_apps
                .is_empty());
            futures::executor::block_on(state.proxy_service.stop_with_restore()).unwrap();
            let restored = std::fs::read_to_string(&path).unwrap();
            assert!(!restored.contains("127.0.0.1:15731"));
            assert!(restored.contains("fake-rotated-under-proxy"));
            assert_eq!(
                state.db.get_current_provider("codex").unwrap().as_deref(),
                Some("old-codex")
            );
            assert_eq!(state.db.get_all_providers("codex").unwrap().len(), 1);
        });
    }
}
