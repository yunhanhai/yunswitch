use super::{live, AppType, McpService, ProviderService};
use crate::database::shared_channel_in_use;
use crate::error::AppError;
use crate::provider::{Provider, UniversalProvider};
use crate::store::AppState;
use serde_json::Value;
use std::collections::HashMap;
use std::str::FromStr;

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedChannelSaveResult {
    pub saved: bool,
    pub synced_apps: Vec<String>,
    pub failed_apps: Vec<String>,
}

fn apps() -> [AppType; 3] {
    [AppType::Claude, AppType::Codex, AppType::Gemini]
}

fn child(channel: &UniversalProvider, app: &AppType) -> Option<Provider> {
    match app {
        AppType::Claude => channel.to_claude_provider(),
        AppType::Codex => channel.to_codex_provider(),
        AppType::Gemini => channel.to_gemini_provider(),
        _ => None,
    }
}

fn invalid_channel() -> AppError {
    AppError::localized(
        "shared_channel.invalid",
        "请填写渠道名称、密钥和有效的 HTTP(S) 地址，并至少选择一个应用；协议必须与应用支持的选项一致。",
        "Enter a channel name, API key and valid HTTP(S) URL, select at least one app, and use a supported protocol.",
    )
}

fn uses_managed_auth(meta: &crate::provider::ProviderMeta) -> bool {
    meta.auth_binding
        .as_ref()
        .is_some_and(|binding| binding.source == crate::provider::AuthBindingSource::ManagedAccount)
        || meta.github_account_id.is_some()
        || matches!(
            meta.provider_type.as_deref(),
            Some("codex_oauth" | "xai_oauth" | "github_copilot")
        )
}

fn validate(channel: &UniversalProvider) -> Result<(), AppError> {
    if channel.id.trim().is_empty()
        || channel.id.chars().any(|c| c.is_control())
        || channel.name.trim().is_empty()
        || channel.api_key.trim().is_empty()
        || !(channel.apps.claude || channel.apps.codex || channel.apps.gemini)
    {
        return Err(invalid_channel());
    }
    let valid_url = |text: &str| {
        url::Url::parse(text).is_ok_and(|url| {
            matches!(url.scheme(), "http" | "https")
                && url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none()
                && url.fragment().is_none()
        })
    };
    if !valid_url(channel.base_url.trim()) {
        return Err(invalid_channel());
    }
    for (enabled, connection, allowed) in [
        (
            channel.apps.claude,
            channel.connections.claude.as_ref(),
            &[
                "anthropic",
                "openai_chat",
                "openai_responses",
                "gemini_native",
            ][..],
        ),
        (
            channel.apps.codex,
            channel.connections.codex.as_ref(),
            &["openai_responses", "openai_chat", "anthropic"][..],
        ),
        (
            channel.apps.gemini,
            channel.connections.gemini.as_ref(),
            &["gemini_native"][..],
        ),
    ] {
        if !enabled {
            continue;
        }
        if let Some(connection) = connection {
            if connection
                .base_url
                .as_deref()
                .is_some_and(|url| !url.trim().is_empty() && !valid_url(url.trim()))
                || connection
                    .api_format
                    .as_deref()
                    .is_some_and(|format| !allowed.contains(&format))
            {
                return Err(invalid_channel());
            }
        }
    }
    if channel.meta.as_ref().is_some_and(uses_managed_auth) {
        return Err(invalid_channel());
    }
    Ok(())
}

fn codex_document(provider: &Provider) -> Result<toml_edit::DocumentMut, AppError> {
    let invalid = || {
        AppError::localized(
            "shared_channel.invalid_codex_config",
            "Codex 高级配置不是有效的 TOML。请先修复该应用配置，再保存共享渠道。",
            "The Codex advanced configuration is not valid TOML. Repair it before saving the shared channel.",
        )
    };
    let document: toml_edit::DocumentMut = provider
        .settings_config
        .get("config")
        .and_then(Value::as_str)
        .unwrap_or("")
        .parse()
        .map_err(|_| invalid())?;
    if let Some(providers) = document.get("model_providers") {
        let table = providers.as_table_like().ok_or_else(invalid)?;
        if table
            .get(codex_provider_id(&document))
            .is_some_and(|provider| provider.as_table_like().is_none())
        {
            return Err(invalid());
        }
    }
    Ok(document)
}

fn codex_provider_id(document: &toml_edit::DocumentMut) -> &str {
    document
        .get("model_provider")
        .and_then(toml_edit::Item::as_str)
        .unwrap_or("custom")
}

fn remove_codex_connection_overrides(document: &mut toml_edit::DocumentMut, provider_id: &str) {
    for key in [
        "base_url",
        "experimental_bearer_token",
        "env_key",
        "http_headers",
        "env_http_headers",
        "wire_api",
    ] {
        document.remove(key);
    }
    if let Some(provider) = document
        .get_mut("model_providers")
        .and_then(toml_edit::Item::as_table_like_mut)
        .and_then(|providers| providers.get_mut(provider_id))
        .and_then(toml_edit::Item::as_table_like_mut)
    {
        for key in [
            "experimental_bearer_token",
            "env_key",
            "env_key_instructions",
        ] {
            provider.remove(key);
        }
        for field in ["http_headers", "env_http_headers"] {
            if let Some(headers) = provider
                .get_mut(field)
                .and_then(toml_edit::Item::as_table_like_mut)
            {
                let secrets: Vec<_> = headers
                    .iter()
                    .filter(|(key, _)| {
                        matches!(
                            key.to_ascii_lowercase().as_str(),
                            "authorization" | "x-api-key" | "api-key" | "cookie"
                        )
                    })
                    .map(|(key, _)| key.to_string())
                    .collect();
                for key in secrets {
                    headers.remove(&key);
                }
            }
        }
    }
}

/// Only fields owned by the channel are patched. Models are updated when the
/// master field changes; independent child model choices survive key rotation.
fn merge_child(
    app: &AppType,
    generated: Provider,
    previous: Option<Provider>,
    existing: Option<Provider>,
) -> Result<Provider, AppError> {
    let Some(mut merged) = existing else {
        return Ok(generated);
    };
    if !merged.settings_config.is_object() {
        return Err(invalid_channel());
    }
    if *app == AppType::Codex {
        let mut document = codex_document(&merged)?;
        let new_document = codex_document(&generated)?;
        let old_document = previous.as_ref().map(codex_document).transpose()?;
        let provider_id = codex_provider_id(&document).to_string();
        remove_codex_connection_overrides(&mut document, &provider_id);
        document["model_provider"] = toml_edit::value(provider_id.clone());
        for field in ["name", "base_url", "wire_api", "requires_openai_auth"] {
            document["model_providers"][&provider_id][field] =
                new_document["model_providers"]["custom"][field].clone();
        }
        for field in ["model", "model_reasoning_effort"] {
            if old_document.as_ref().is_some_and(|old| {
                old.get(field).and_then(toml_edit::Item::as_str)
                    != new_document.get(field).and_then(toml_edit::Item::as_str)
            }) || document.get(field).is_none()
            {
                document[field] = new_document[field].clone();
            }
        }
        merged.settings_config["config"] = Value::String(document.to_string());
        if !merged
            .settings_config
            .get("auth")
            .is_some_and(Value::is_object)
        {
            merged.settings_config["auth"] = serde_json::json!({});
        }
        merged.settings_config["auth"]["OPENAI_API_KEY"] =
            generated.settings_config["auth"]["OPENAI_API_KEY"].clone();
        if let Some(env) = merged
            .settings_config
            .get_mut("env")
            .and_then(Value::as_object_mut)
        {
            env.remove("OPENAI_API_KEY");
        }
        // These legacy top-level aliases must not override the channel protocol.
        if let Some(settings) = merged.settings_config.as_object_mut() {
            for key in [
                "apiFormat",
                "api_format",
                "base_url",
                "baseUrl",
                "baseURL",
                "api_key",
                "apiKey",
            ] {
                settings.remove(key);
            }
        }
    } else {
        if !merged
            .settings_config
            .get("env")
            .is_some_and(Value::is_object)
        {
            merged.settings_config["env"] = serde_json::json!({});
        }
        let env = generated.settings_config["env"]
            .as_object()
            .expect("generated env");
        for (key, value) in env {
            let model_field = key.contains("MODEL");
            let changed = previous
                .as_ref()
                .is_some_and(|old| old.settings_config["env"].get(key) != Some(value));
            if !model_field || changed || merged.settings_config["env"].get(key).is_none() {
                merged.settings_config["env"][key] = value.clone();
            }
        }
        if *app == AppType::Claude {
            merged.settings_config["env"]
                .as_object_mut()
                .expect("env")
                .remove("ANTHROPIC_API_KEY");
        }
    }
    merged.name = generated.name;
    merged.website_url = generated.website_url;
    merged.icon = generated.icon;
    merged.icon_color = generated.icon_color;
    let generated_meta = generated.meta.unwrap_or_default();
    let meta = merged.meta.get_or_insert_with(Default::default);
    meta.shared_channel_id = generated_meta.shared_channel_id;
    meta.api_format = generated_meta.api_format;
    // A shared API-key channel cannot retain an old managed-account identity.
    if uses_managed_auth(meta) {
        meta.auth_binding = None;
        meta.github_account_id = None;
        meta.provider_type = None;
    }
    if *app == AppType::Claude {
        meta.api_key_field = Some("ANTHROPIC_AUTH_TOKEN".to_string());
    }
    Ok(merged)
}

/// Common preferences may add models, hooks and MCP options, but cannot
/// replace a shared channel's effective connection or remove it from storage.
pub(super) fn reapply_shared_settings(
    db: &crate::database::Database,
    app: &AppType,
    provider: &Provider,
    settings: &mut Value,
) -> Result<(), AppError> {
    let prefix = format!("universal-{}-", app.as_str());
    let id = provider
        .meta
        .as_ref()
        .and_then(|meta| meta.shared_channel_id.as_deref())
        .or_else(|| provider.id.strip_prefix(&prefix));
    let Some(channel) = id
        .map(|id| db.get_universal_provider(id))
        .transpose()?
        .flatten()
    else {
        return Ok(());
    };
    let Some(generated) = child(&channel, app) else {
        return Err(invalid_channel());
    };
    if generated.id != provider.id {
        return Err(invalid_channel());
    }
    let mut effective = provider.clone();
    effective.settings_config = settings.clone();
    // The common snippet must not select another provider table. Preserve the
    // child's own selector and reapply managed fields to that table.
    let missing_models = if *app == AppType::Codex {
        let original = codex_document(provider)?;
        let mut document = codex_document(&effective)?;
        let missing = ["model", "model_reasoning_effort"]
            .into_iter()
            .filter(|key| document.get(key).is_none())
            .map(str::to_string)
            .collect::<Vec<_>>();
        document["model_provider"] = toml_edit::value(codex_provider_id(&original));
        effective.settings_config["config"] = Value::String(document.to_string());
        missing
    } else {
        generated.settings_config["env"]
            .as_object()
            .into_iter()
            .flat_map(|env| env.keys())
            .filter(|key| key.contains("MODEL") && settings["env"].get(*key).is_none())
            .cloned()
            .collect::<Vec<_>>()
    };
    let mut merged = merge_child(app, generated, None, Some(effective))?;
    // Common model defaults remain common; do not materialize them back into
    // stored children merely because the credential fields were restored.
    if *app == AppType::Codex {
        let mut document = codex_document(&merged)?;
        for key in missing_models {
            document.remove(&key);
        }
        merged.settings_config["config"] = Value::String(document.to_string());
    } else if let Some(env) = merged
        .settings_config
        .get_mut("env")
        .and_then(Value::as_object_mut)
    {
        for key in missing_models {
            env.remove(&key);
        }
    }
    *settings = merged.settings_config;
    Ok(())
}

impl ProviderService {
    pub(super) fn validate_shared_child_add(
        app: &AppType,
        provider: &Provider,
    ) -> Result<(), AppError> {
        if provider
            .id
            .starts_with(&format!("universal-{}-", app.as_str()))
            || provider
                .meta
                .as_ref()
                .is_some_and(|meta| meta.shared_channel_id.is_some())
        {
            return Err(AppError::Message(
                "Create linked providers from Shared channels".into(),
            ));
        }
        Ok(())
    }

    fn hydrate_legacy_connections(
        state: &AppState,
        provider: &mut UniversalProvider,
    ) -> Result<(), AppError> {
        let legacy_format = provider
            .meta
            .as_ref()
            .and_then(|meta| meta.api_format.clone());
        for app in apps() {
            let (connection, default_format) = match app {
                AppType::Claude => (&mut provider.connections.claude, "anthropic"),
                AppType::Codex => (&mut provider.connections.codex, "openai_responses"),
                _ => (&mut provider.connections.gemini, "gemini_native"),
            };
            if connection
                .as_ref()
                .is_some_and(|connection| connection.api_format.is_some())
            {
                continue;
            }
            let existing = state.db.get_provider_by_id(
                &format!("universal-{}-{}", app.as_str(), provider.id),
                app.as_str(),
            )?;
            let old_child_format = existing
                .filter(|existing| {
                    existing
                        .meta
                        .as_ref()
                        .is_none_or(|meta| meta.shared_channel_id.is_none())
                })
                .and_then(|existing| {
                    existing
                        .meta
                        .as_ref()
                        .and_then(|meta| meta.api_format.clone())
                        .or_else(|| {
                            if app == AppType::Codex {
                                codex_document(&existing).ok().and_then(|doc| {
                                    doc.get("model_providers")
                                        .and_then(|providers| {
                                            providers.get(codex_provider_id(&doc))
                                        })
                                        .and_then(|provider| provider.get("wire_api"))
                                        .and_then(toml_edit::Item::as_str)
                                        .and_then(|format| match format {
                                            "chat" => Some("openai_chat".to_string()),
                                            "anthropic" => Some("anthropic".to_string()),
                                            "responses" => Some("openai_responses".to_string()),
                                            _ => None,
                                        })
                                })
                            } else {
                                None
                            }
                        })
                });
            let format = old_child_format
                .filter(|format| {
                    UniversalProvider::supports_connection_format(default_format, format)
                })
                .or_else(|| {
                    legacy_format.clone().filter(|format| {
                        UniversalProvider::supports_connection_format(default_format, format)
                    })
                })
                .unwrap_or_else(|| default_format.to_string());
            connection.get_or_insert_with(Default::default).api_format = Some(format);
        }
        Ok(())
    }

    pub fn list_universal(
        state: &AppState,
    ) -> Result<HashMap<String, UniversalProvider>, AppError> {
        let mut providers = state.db.get_all_universal_providers()?;
        for provider in providers.values_mut() {
            Self::hydrate_legacy_connections(state, provider)?;
        }
        Ok(providers)
    }

    pub fn get_universal(
        state: &AppState,
        id: &str,
    ) -> Result<Option<UniversalProvider>, AppError> {
        let mut provider = state.db.get_universal_provider(id)?;
        if let Some(provider) = provider.as_mut() {
            Self::hydrate_legacy_connections(state, provider)?;
        }
        Ok(provider)
    }

    /// Legacy callers also receive atomic, safe synchronization.
    pub fn upsert_universal(
        state: &AppState,
        provider: UniversalProvider,
    ) -> Result<bool, AppError> {
        let result = Self::save_shared_channel(state, provider)?;
        if result.failed_apps.is_empty() {
            Ok(true)
        } else {
            Err(AppError::Message(format!(
                "Shared channel saved; retry live synchronization for: {}",
                result.failed_apps.join(", ")
            )))
        }
    }

    pub fn preview_shared_channel(
        mut provider: UniversalProvider,
    ) -> Result<HashMap<String, Provider>, AppError> {
        validate(&provider)?;
        provider.api_key = "[REDACTED]".to_string();
        // Keep only the legacy protocol fallback: removing it would preview a
        // different wire format from the configuration saved by old clients.
        provider.meta = provider
            .meta
            .and_then(|meta| meta.api_format)
            .map(|api_format| crate::provider::ProviderMeta {
                api_format: Some(api_format),
                ..Default::default()
            });
        provider.notes = None;
        fn mask_url(text: &mut String) {
            if let Ok(mut url) = url::Url::parse(text) {
                if url.query().is_some() {
                    url.set_query(Some("[REDACTED]"));
                    *text = url.to_string();
                }
            }
        }
        mask_url(&mut provider.base_url);
        for connection in [
            &mut provider.connections.claude,
            &mut provider.connections.codex,
            &mut provider.connections.gemini,
        ]
        .into_iter()
        .flatten()
        {
            if let Some(url) = connection.base_url.as_mut() {
                mask_url(url);
            }
        }
        Ok(apps()
            .into_iter()
            .filter_map(|app| child(&provider, &app).map(|child| (app.as_str().to_string(), child)))
            .collect())
    }

    pub fn save_shared_channel(
        state: &AppState,
        mut provider: UniversalProvider,
    ) -> Result<SharedChannelSaveResult, AppError> {
        validate(&provider)?;
        provider.base_url = provider.base_url.trim().to_string();
        // Fixed order matches all shared-channel operations. Holding the locks
        // through projection prevents takeover/switch from resurrecting old keys.
        let _claude =
            futures::executor::block_on(state.proxy_service.lock_switch_for_app("claude"));
        let _codex = futures::executor::block_on(state.proxy_service.lock_switch_for_app("codex"));
        let _gemini =
            futures::executor::block_on(state.proxy_service.lock_switch_for_app("gemini"));
        Self::save_shared_channel_locked(state, provider)
    }

    /// The caller holds all three app switch locks before reading the master.
    fn save_shared_channel_locked(
        state: &AppState,
        mut provider: UniversalProvider,
    ) -> Result<SharedChannelSaveResult, AppError> {
        Self::hydrate_legacy_connections(state, &mut provider)?;
        validate(&provider)?;
        let previous = Self::get_universal(state, &provider.id)?;
        let mut children = Vec::new();
        let mut removed_apps = Vec::new();
        for app in apps() {
            let child_id = format!("universal-{}-{}", app.as_str(), provider.id);
            if let Some(generated) = child(&provider, &app) {
                let existing = state.db.get_provider_by_id(&child_id, app.as_str())?;
                let merged = merge_child(
                    &app,
                    generated,
                    previous.as_ref().and_then(|previous| child(previous, &app)),
                    existing,
                )?;
                Self::validate_provider_settings(&app, &merged)?;
                children.push((app.as_str().to_string(), merged));
            } else {
                if crate::settings::get_current_provider(&app).as_deref() == Some(&child_id) {
                    return Err(shared_channel_in_use());
                }
                removed_apps.push(app.as_str().to_string());
            }
        }
        state
            .db
            .save_shared_channel_children(&provider, &children, &removed_apps)?;
        let mut result = SharedChannelSaveResult {
            saved: true,
            synced_apps: Vec::new(),
            failed_apps: Vec::new(),
        };
        for (app, child) in children {
            let app_type = AppType::from_str(&app)?;
            let projection = (|| {
                if crate::settings::get_effective_current_provider(&state.db, &app_type)?.as_deref()
                    == Some(&child.id)
                {
                    let outcome = live::sync_live_for_provider_respecting_takeover_locked(
                        state, &app_type, &child,
                    )?;
                    if outcome == live::LiveSyncOutcome::WroteLive {
                        McpService::sync_enabled_for_app(state, &app_type)?;
                    }
                }
                Ok::<_, AppError>(())
            })();
            if projection.is_ok() {
                result.synced_apps.push(app);
            } else {
                // Config parsing errors can contain credentials; never log them.
                log::warn!("Shared channel saved; {app} live projection failed");
                result.failed_apps.push(app);
            }
        }
        Ok(result)
    }

    pub fn resync_shared_channel(
        state: &AppState,
        id: &str,
    ) -> Result<SharedChannelSaveResult, AppError> {
        let _claude =
            futures::executor::block_on(state.proxy_service.lock_switch_for_app("claude"));
        let _codex = futures::executor::block_on(state.proxy_service.lock_switch_for_app("codex"));
        let _gemini =
            futures::executor::block_on(state.proxy_service.lock_switch_for_app("gemini"));
        let provider = Self::get_universal(state, id)?
            .ok_or_else(|| AppError::Message("Shared channel not found".to_string()))?;
        Self::save_shared_channel_locked(state, provider)
    }

    pub fn sync_universal_to_apps(state: &AppState, id: &str) -> Result<bool, AppError> {
        let result = Self::resync_shared_channel(state, id)?;
        if result.failed_apps.is_empty() {
            Ok(true)
        } else {
            Err(AppError::Message(format!(
                "Shared channel saved; retry live synchronization for: {}",
                result.failed_apps.join(", ")
            )))
        }
    }

    pub fn delete_universal(state: &AppState, id: &str) -> Result<bool, AppError> {
        let _claude =
            futures::executor::block_on(state.proxy_service.lock_switch_for_app("claude"));
        let _codex = futures::executor::block_on(state.proxy_service.lock_switch_for_app("codex"));
        let _gemini =
            futures::executor::block_on(state.proxy_service.lock_switch_for_app("gemini"));
        for app in apps() {
            if crate::settings::get_current_provider(&app).as_deref()
                == Some(&format!("universal-{}-{id}", app.as_str()))
            {
                return Err(shared_channel_in_use());
            }
        }
        state.db.delete_shared_channel_children(id)
    }

    /// Live backfill may keep per-app models and advanced options, but the
    /// channel remains authoritative for credentials, endpoint and protocol.
    /// The switch caller already holds this app's lock.
    pub(super) fn reapply_shared_connection_for_backfill(
        state: &AppState,
        app: &AppType,
        provider: &mut Provider,
    ) -> Result<(), AppError> {
        let prefix = format!("universal-{}-", app.as_str());
        let id = provider
            .meta
            .as_ref()
            .and_then(|meta| meta.shared_channel_id.as_deref())
            .or_else(|| provider.id.strip_prefix(&prefix));
        let Some(channel) = id
            .map(|id| Self::get_universal(state, id))
            .transpose()?
            .flatten()
        else {
            return Ok(());
        };
        let generated = child(&channel, app).ok_or_else(invalid_channel)?;
        if generated.id != provider.id {
            return Err(invalid_channel());
        }
        *provider = merge_child(
            app,
            generated.clone(),
            Some(generated),
            Some(provider.clone()),
        )?;
        Ok(())
    }

    /// Keep advanced per-app edits available without creating divergent copies
    /// of the channel credentials. Old generated IDs are recognized as well.
    pub(super) fn validate_shared_child_update(
        state: &AppState,
        app: &AppType,
        existing: Option<&Provider>,
        updated: &mut Provider,
    ) -> Result<(), AppError> {
        let Some(existing) = existing else {
            return Self::validate_shared_child_add(app, updated);
        };
        let prefix = format!("universal-{}-", app.as_str());
        let id = existing
            .meta
            .as_ref()
            .and_then(|meta| meta.shared_channel_id.as_deref())
            .or_else(|| existing.id.strip_prefix(&prefix));
        let Some(channel) = id
            .map(|id| Self::get_universal(state, id))
            .transpose()?
            .flatten()
        else {
            if updated
                .meta
                .as_ref()
                .is_some_and(|meta| meta.shared_channel_id.is_some())
                || existing
                    .meta
                    .as_ref()
                    .is_some_and(|meta| meta.shared_channel_id.is_some())
            {
                return Err(invalid_channel());
            }
            return Ok(());
        };
        if existing.id != format!("universal-{}-{}", app.as_str(), channel.id)
            || updated.id != existing.id
            || updated
                .meta
                .as_ref()
                .and_then(|meta| meta.shared_channel_id.as_deref())
                .is_some_and(|id| id != channel.id)
            || updated.meta.as_ref().is_some_and(uses_managed_auth)
        {
            return Err(invalid_channel());
        }
        let Some(expected) = child(&channel, app) else {
            return Err(invalid_channel());
        };
        let supplied_format = updated
            .meta
            .as_ref()
            .and_then(|meta| meta.api_format.as_deref());
        let expected_format = expected
            .meta
            .as_ref()
            .and_then(|meta| meta.api_format.as_deref());
        let connection_changed = if *app == AppType::Codex {
            let document = codex_document(updated)?;
            let mut sanitized = document.clone();
            remove_codex_connection_overrides(&mut sanitized, codex_provider_id(&document));
            if sanitized.to_string() != document.to_string()
                || updated.settings_config["env"]
                    .get("OPENAI_API_KEY")
                    .is_some()
                || [
                    "base_url",
                    "baseUrl",
                    "baseURL",
                    "apiKey",
                    "api_key",
                    "apiFormat",
                    "api_format",
                ]
                .iter()
                .any(|key| updated.settings_config.get(key).is_some())
            {
                return Err(invalid_channel());
            }
            let expected_document = codex_document(&expected)?;
            let provider_id = codex_provider_id(&document);
            let supplied = document
                .get("model_providers")
                .and_then(|providers| providers.get(provider_id));
            let expected_connection = &expected_document["model_providers"]["custom"];
            ["base_url", "wire_api"].iter().any(|key| {
                supplied
                    .and_then(|provider| provider.get(key))
                    .and_then(toml_edit::Item::as_str)
                    != expected_connection
                        .get(key)
                        .and_then(toml_edit::Item::as_str)
            }) || supplied
                .and_then(|provider| provider.get("requires_openai_auth"))
                .and_then(toml_edit::Item::as_bool)
                != expected_connection
                    .get("requires_openai_auth")
                    .and_then(toml_edit::Item::as_bool)
                || updated.settings_config["auth"]["OPENAI_API_KEY"]
                    != expected.settings_config["auth"]["OPENAI_API_KEY"]
        } else {
            if *app == AppType::Claude
                && (updated.settings_config["env"]
                    .get("ANTHROPIC_API_KEY")
                    .is_some()
                    || updated
                        .meta
                        .as_ref()
                        .and_then(|meta| meta.api_key_field.as_deref())
                        .is_some_and(|field| field != "ANTHROPIC_AUTH_TOKEN"))
            {
                return Err(invalid_channel());
            }
            let keys = if *app == AppType::Claude {
                ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"]
            } else {
                ["GOOGLE_GEMINI_BASE_URL", "GEMINI_API_KEY"]
            };
            keys.iter().any(|key| {
                updated.settings_config["env"][key] != expected.settings_config["env"][key]
            })
        };
        if connection_changed || (supplied_format.is_some() && supplied_format != expected_format) {
            return Err(AppError::localized(
                "shared_channel.edit_connection",
                "地址、密钥和协议由共享渠道管理，请从“编辑共享渠道”修改。",
                "Edit the shared channel to change its URL, API key or protocol.",
            ));
        }
        let meta = updated.meta.get_or_insert_with(Default::default);
        meta.shared_channel_id = Some(channel.id);
        meta.api_format = expected_format.map(str::to_string);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::{CodexModelConfig, SharedChannelConnection};
    use serial_test::serial;

    fn with_shared_test_home(test: impl FnOnce(&AppState, &std::path::Path)) {
        super::super::tests::with_test_home(|state, home| {
            crate::settings::reload_settings().unwrap();
            test(state, home);
        });
    }

    fn channel() -> UniversalProvider {
        let mut channel = UniversalProvider::new(
            "test-channel".into(),
            "Synthetic shared channel".into(),
            "custom".into(),
            "https://synthetic.example".into(),
            "sk-fake-before".into(),
        );
        channel.apps.claude = true;
        channel.apps.codex = true;
        channel
    }

    #[test]
    fn shared_channel_key_rotation_preserves_codex_advanced_settings_and_model() {
        let old = channel();
        let mut existing = old.to_codex_provider().unwrap();
        let mut document = codex_document(&existing).unwrap();
        document["model"] = toml_edit::value("independent-model");
        document["approval_policy"] = toml_edit::value("never");
        document["sandbox_mode"] = toml_edit::value("workspace-write");
        document["mcp_servers"]["synthetic"]["command"] = toml_edit::value("fake-mcp");
        document["model_providers"]["custom"]["request_max_retries"] = toml_edit::value(3);
        existing.settings_config["config"] = Value::String(document.to_string());
        existing.settings_config["unknown"] = serde_json::json!({"preserve": true});
        existing.notes = Some("application note".into());
        existing.sort_index = Some(9);
        existing.meta.as_mut().unwrap().max_output_tokens = Some(1234);
        let mut updated = old.clone();
        updated.api_key = "sk-fake-after".into();
        updated.connections.codex = Some(SharedChannelConnection {
            base_url: Some("https://synthetic.example/prefix".into()),
            api_format: Some("openai_chat".into()),
        });
        let merged = merge_child(
            &AppType::Codex,
            updated.to_codex_provider().unwrap(),
            old.to_codex_provider(),
            Some(existing),
        )
        .unwrap();
        let document = codex_document(&merged).unwrap();
        assert_eq!(document["model"].as_str(), Some("independent-model"));
        assert_eq!(document["approval_policy"].as_str(), Some("never"));
        assert_eq!(document["sandbox_mode"].as_str(), Some("workspace-write"));
        assert_eq!(
            document["mcp_servers"]["synthetic"]["command"].as_str(),
            Some("fake-mcp")
        );
        assert_eq!(
            document["model_providers"]["custom"]["request_max_retries"].as_integer(),
            Some(3)
        );
        assert_eq!(
            document["model_providers"]["custom"]["base_url"].as_str(),
            Some("https://synthetic.example/prefix")
        );
        assert_eq!(
            document["model_providers"]["custom"]["wire_api"].as_str(),
            Some("responses")
        );
        assert_eq!(
            merged.settings_config["auth"]["OPENAI_API_KEY"],
            "sk-fake-after"
        );
        assert_eq!(merged.settings_config["unknown"]["preserve"], true);
        assert_eq!(merged.meta.unwrap().max_output_tokens, Some(1234));
        assert_eq!(merged.notes.as_deref(), Some("application note"));
        assert_eq!(merged.sort_index, Some(9));
    }

    #[test]
    fn shared_channel_explicit_model_update_and_toml_escaping() {
        let old = channel();
        let mut updated = old.clone();
        updated.name = "Name \" quoted".into();
        updated.models.codex = Some(CodexModelConfig {
            model: Some("model\"quoted".into()),
            reasoning_effort: Some("low".into()),
        });
        let merged = merge_child(
            &AppType::Codex,
            updated.to_codex_provider().unwrap(),
            old.to_codex_provider(),
            old.to_codex_provider(),
        )
        .unwrap();
        let document = codex_document(&merged).unwrap();
        assert_eq!(document["model"].as_str(), Some("model\"quoted"));
        assert_eq!(document["model_reasoning_effort"].as_str(), Some("low"));
        assert_eq!(
            document["model_providers"]["custom"]["name"].as_str(),
            Some("Name \" quoted")
        );
    }

    #[test]
    fn shared_channel_preview_masks_credentials_and_uses_backend_endpoint_rules() {
        let mut channel = channel();
        channel.connections.codex = Some(SharedChannelConnection {
            base_url: Some("https://synthetic.example/custom".into()),
            api_format: None,
        });
        let preview = ProviderService::preview_shared_channel(channel).unwrap();
        let serialized = serde_json::to_string(&preview).unwrap();
        assert!(!serialized.contains("sk-fake-before"));
        assert!(serialized.contains("[REDACTED]"));
        let document = codex_document(&preview["codex"]).unwrap();
        assert_eq!(
            document["model_providers"]["custom"]["base_url"].as_str(),
            Some("https://synthetic.example/custom")
        );
        assert_eq!(
            preview["claude"]
                .meta
                .as_ref()
                .unwrap()
                .shared_channel_id
                .as_deref(),
            Some("test-channel")
        );
    }

    #[test]
    fn shared_channel_malformed_codex_toml_is_safe_error() {
        let channel = channel();
        let mut existing = channel.to_codex_provider().unwrap();
        existing.settings_config["config"] = Value::String("api_key = sk-fake-secret".into());
        let error = merge_child(
            &AppType::Codex,
            channel.to_codex_provider().unwrap(),
            channel.to_codex_provider(),
            Some(existing),
        )
        .unwrap_err()
        .to_string();
        assert!(!error.contains("sk-fake-secret"));
    }

    #[test]
    fn shared_channel_rotation_removes_stale_codex_auth_overrides() {
        let original = channel();
        let mut existing = original.to_codex_provider().unwrap();
        let mut document = codex_document(&existing).unwrap();
        document["experimental_bearer_token"] = toml_edit::value("fake-stale-token");
        document["model_providers"]["custom"]["env_key"] = toml_edit::value("FAKE_OLD_KEY");
        document["model_providers"]["custom"]["http_headers"]["Authorization"] =
            toml_edit::value("Bearer fake-stale-token");
        document["model_providers"]["custom"]["http_headers"]["X-Custom-Routing"] =
            toml_edit::value("keep");
        existing.settings_config["config"] = Value::String(document.to_string());
        existing.settings_config["base_url"] = Value::String("https://old.example".into());
        existing.settings_config["env"] =
            serde_json::json!({"OPENAI_API_KEY": "fake-stale-env-key", "UNRELATED": "keep"});
        let mut rotated = original.clone();
        rotated.api_key = "fake-rotated-key".into();
        let merged = merge_child(
            &AppType::Codex,
            rotated.to_codex_provider().unwrap(),
            original.to_codex_provider(),
            Some(existing),
        )
        .unwrap();
        let text = serde_json::to_string(&merged.settings_config).unwrap();
        assert!(!text.contains("fake-stale-token"));
        assert!(!text.contains("FAKE_OLD_KEY"));
        assert!(!text.contains("old.example"));
        assert!(text.contains("X-Custom-Routing"));
        assert!(text.contains("fake-rotated-key"));
        assert!(!text.contains("fake-stale-env-key"));
        assert_eq!(merged.settings_config["env"]["UNRELATED"], "keep");
        use crate::proxy::providers::{CodexAdapter, ProviderAdapter};
        assert_eq!(
            CodexAdapter::new().extract_auth(&merged).unwrap().api_key,
            "fake-rotated-key"
        );
    }

    #[test]
    #[serial]
    fn shared_channel_second_child_database_failure_rolls_back_master_and_first_child() {
        with_shared_test_home(|state, _| {
            let original = channel();
            ProviderService::save_shared_channel(state, original.clone()).unwrap();
            state.db.conn.lock().unwrap().execute_batch("CREATE TRIGGER fail_shared_codex_update BEFORE UPDATE ON providers WHEN NEW.app_type = 'codex' BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END;").unwrap();
            let mut updated = original.clone();
            updated.api_key = "fake-rejected-rotation".into();
            assert!(ProviderService::save_shared_channel(state, updated).is_err());
            assert_eq!(
                state
                    .db
                    .get_universal_provider(&original.id)
                    .unwrap()
                    .unwrap()
                    .api_key,
                original.api_key
            );
            for app in apps().into_iter().take(2) {
                let child = state
                    .db
                    .get_provider_by_id(
                        &format!("universal-{}-test-channel", app.as_str()),
                        app.as_str(),
                    )
                    .unwrap()
                    .unwrap();
                assert!(!serde_json::to_string(&child)
                    .unwrap()
                    .contains("fake-rejected-rotation"));
            }
        });
    }

    #[test]
    #[serial]
    fn shared_channel_legacy_protocol_is_preserved_when_connections_are_absent() {
        with_shared_test_home(|state, _| {
            let mut original = channel();
            original.meta = Some(crate::provider::ProviderMeta {
                api_format: Some("openai_chat".into()),
                ..Default::default()
            });
            state.db.save_universal_provider(&original).unwrap();
            let mut child = original.to_codex_provider().unwrap();
            child.meta.as_mut().unwrap().shared_channel_id = None;
            state.db.save_provider("codex", &child).unwrap();
            let loaded = ProviderService::get_universal(state, &original.id)
                .unwrap()
                .unwrap();
            assert_eq!(
                loaded.connections.codex.unwrap().api_format.as_deref(),
                Some("openai_chat")
            );
            let mut edited = child.clone();
            edited.notes = Some("Legacy notes remain editable".into());
            ProviderService::validate_shared_child_update(
                state,
                &AppType::Codex,
                Some(&child),
                &mut edited,
            )
            .unwrap();
            original.api_key = "fake-rotated-key".into();
            ProviderService::save_shared_channel(state, original).unwrap();
            let child = state
                .db
                .get_provider_by_id("universal-codex-test-channel", "codex")
                .unwrap()
                .unwrap();
            assert_eq!(
                child.meta.as_ref().unwrap().api_format.as_deref(),
                Some("openai_chat")
            );
            assert_eq!(
                codex_document(&child).unwrap()["model_providers"]["custom"]["wire_api"].as_str(),
                Some("responses")
            );
        });
    }

    #[test]
    #[serial]
    fn shared_channel_takeover_rotates_backup_without_overwriting_proxy_endpoint() {
        with_shared_test_home(|state, _| {
            let mut original = channel();
            ProviderService::save_shared_channel(state, original.clone()).unwrap();
            state
                .db
                .set_current_provider("claude", "universal-claude-test-channel")
                .unwrap();
            let child = original.to_claude_provider().unwrap();
            futures::executor::block_on(
                state
                    .db
                    .save_live_backup("claude", &child.settings_config.to_string()),
            )
            .unwrap();
            let proxy_settings = serde_json::json!({"env": {"ANTHROPIC_BASE_URL": "http://127.0.0.1:15721", "ANTHROPIC_AUTH_TOKEN": "PROXY_MANAGED"}});
            crate::config::write_json_file(
                &crate::config::get_claude_settings_path(),
                &proxy_settings,
            )
            .unwrap();
            original.api_key = "fake-rotated-key".into();
            let result = ProviderService::save_shared_channel(state, original).unwrap();
            assert!(result.failed_apps.is_empty());
            let live: Value =
                crate::config::read_json_file(&crate::config::get_claude_settings_path()).unwrap();
            assert_eq!(live, proxy_settings);
            let backup = futures::executor::block_on(state.db.get_live_backup("claude"))
                .unwrap()
                .unwrap();
            let backup: Value = serde_json::from_str(&backup.original_config).unwrap();
            assert_eq!(backup["env"]["ANTHROPIC_AUTH_TOKEN"], "fake-rotated-key");
        });
    }

    #[test]
    #[serial]
    fn shared_channel_save_creates_both_apps_without_switching() {
        with_shared_test_home(|state, _| {
            let result = ProviderService::save_shared_channel(state, channel()).unwrap();
            assert!(result.saved);
            assert_eq!(result.synced_apps, ["claude", "codex"]);
            assert!(result.failed_apps.is_empty());
            for app in ["claude", "codex"] {
                assert!(state
                    .db
                    .get_provider_by_id(&format!("universal-{app}-test-channel"), app)
                    .unwrap()
                    .is_some());
                assert!(state.db.get_current_provider(app).unwrap().is_none());
            }
        });
    }

    #[test]
    #[serial]
    fn shared_channel_disable_current_is_atomic_and_delete_is_blocked() {
        with_shared_test_home(|state, _| {
            let original = channel();
            ProviderService::save_shared_channel(state, original.clone()).unwrap();
            state
                .db
                .set_current_provider("codex", "universal-codex-test-channel")
                .unwrap();
            let mut updated = original.clone();
            updated.apps.codex = false;
            updated.api_key = "sk-fake-rejected".into();
            assert!(ProviderService::save_shared_channel(state, updated).is_err());
            assert!(ProviderService::delete_universal(state, &original.id).is_err());
            assert_eq!(
                state
                    .db
                    .get_universal_provider(&original.id)
                    .unwrap()
                    .unwrap()
                    .api_key,
                original.api_key
            );
            assert_eq!(
                state
                    .db
                    .get_provider_by_id("universal-claude-test-channel", "claude")
                    .unwrap()
                    .unwrap()
                    .settings_config["env"]["ANTHROPIC_AUTH_TOKEN"],
                original.api_key
            );
        });
    }

    #[test]
    #[serial]
    fn shared_channel_routing_reference_blocks_removal_until_detached() {
        with_shared_test_home(|state, _| {
            let channel = channel();
            ProviderService::save_shared_channel(state, channel.clone()).unwrap();
            let group = state
                .db
                .create_routing_group("claude", "Synthetic group", None)
                .unwrap();
            state
                .db
                .set_routing_group_members(&group.id, &["universal-claude-test-channel".into()])
                .unwrap();
            assert!(ProviderService::delete_universal(state, &channel.id).is_err());
            state.db.set_routing_group_members(&group.id, &[]).unwrap();
            ProviderService::delete_universal(state, &channel.id).unwrap();
            assert!(state
                .db
                .get_universal_provider(&channel.id)
                .unwrap()
                .is_none());
            assert!(state
                .db
                .get_provider_by_id("universal-codex-test-channel", "codex")
                .unwrap()
                .is_none());
        });
    }

    #[test]
    #[serial]
    fn shared_channel_partial_live_failure_commits_and_reports_only_app_names() {
        with_shared_test_home(|state, _| {
            let mut channel = channel();
            ProviderService::save_shared_channel(state, channel.clone()).unwrap();
            state
                .db
                .set_current_provider("claude", "universal-claude-test-channel")
                .unwrap();
            state
                .db
                .set_current_provider("codex", "universal-codex-test-channel")
                .unwrap();
            std::fs::create_dir_all(crate::config::get_claude_settings_path()).unwrap();
            channel.api_key = "sk-fake-rotated".into();
            let result = ProviderService::save_shared_channel(state, channel.clone()).unwrap();
            assert_eq!(result.failed_apps, ["claude"]);
            assert_eq!(result.synced_apps, ["codex"]);
            assert!(!serde_json::to_string(&result).unwrap().contains("sk-fake"));
            assert_eq!(
                state
                    .db
                    .get_universal_provider(&channel.id)
                    .unwrap()
                    .unwrap()
                    .api_key,
                "sk-fake-rotated"
            );
        });
    }

    #[test]
    #[serial]
    fn shared_channel_managed_auth_cannot_override_shared_identity() {
        with_shared_test_home(|state, _| {
            let channel = channel();
            ProviderService::save_shared_channel(state, channel.clone()).unwrap();
            let original = channel.to_codex_provider().unwrap();
            for provider_type in ["codex_oauth", "github_copilot", "xai_oauth"] {
                let mut invalid = channel.clone();
                invalid.meta = Some(crate::provider::ProviderMeta {
                    provider_type: Some(provider_type.into()),
                    ..Default::default()
                });
                assert!(validate(&invalid).is_err());
                let mut updated = original.clone();
                updated.meta.as_mut().unwrap().provider_type = Some(provider_type.into());
                assert!(ProviderService::validate_shared_child_update(
                    state,
                    &AppType::Codex,
                    Some(&original),
                    &mut updated
                )
                .is_err());
                // Old accidental metadata is repaired on an explicit channel save.
                let merged = merge_child(
                    &AppType::Codex,
                    original.clone(),
                    Some(original.clone()),
                    Some(updated),
                )
                .unwrap();
                assert!(!merged.is_codex_oauth());
                assert!(!merged.is_xai_oauth());
                assert!(!merged.is_github_copilot());
            }
            let mut updated = original.clone();
            updated.settings_config["env"] =
                serde_json::json!({"OPENAI_API_KEY": "fake-other-key"});
            assert!(ProviderService::validate_shared_child_update(
                state,
                &AppType::Codex,
                Some(&original),
                &mut updated
            )
            .is_err());
        });
    }

    #[test]
    #[serial]
    fn shared_channel_child_edits_compare_toml_values_and_reject_missing_connection() {
        with_shared_test_home(|state, _| {
            let channel = channel();
            ProviderService::save_shared_channel(state, channel.clone()).unwrap();
            let original = channel.to_codex_provider().unwrap();
            let mut updated = original.clone();
            updated.settings_config["config"] = serde_json::json!(
                r#"model_provider = 'custom'
model = 'my-independent-model'
[model_providers.custom]
name = 'Synthetic shared channel'
base_url = 'https://synthetic.example/v1' # harmless formatting
wire_api = 'responses'
requires_openai_auth = true # still the same value
"#
            );
            ProviderService::validate_shared_child_update(
                state,
                &AppType::Codex,
                Some(&original),
                &mut updated,
            )
            .unwrap();
            for config in ["", "model_providers = 'wrong'", "[model_providers]\ncustom = 'wrong'", "model_provider = 'missing'\n[model_providers.other]\nbase_url = 'https://synthetic.example/v1'"] {
                updated.settings_config["config"] = serde_json::json!(config);
                assert!(ProviderService::validate_shared_child_update(state, &AppType::Codex, Some(&original), &mut updated).is_err());
            }
        });
    }

    #[test]
    fn shared_channel_inline_codex_table_preserves_advanced_values_on_rotation() {
        let channel = channel();
        let mut existing = channel.to_codex_provider().unwrap();
        existing.settings_config["config"] = serde_json::json!(
            r#"model_provider = 'custom'
model = 'my-model'
model_providers = {custom = {base_url = 'https://old.example', request_max_retries = 3}}
"#
        );
        let merged = merge_child(
            &AppType::Codex,
            channel.to_codex_provider().unwrap(),
            channel.to_codex_provider(),
            Some(existing),
        )
        .unwrap();
        let doc = codex_document(&merged).unwrap();
        assert_eq!(
            doc["model_providers"]["custom"]["base_url"].as_str(),
            Some("https://synthetic.example/v1")
        );
        assert_eq!(
            doc["model_providers"]["custom"]["request_max_retries"].as_integer(),
            Some(3)
        );
        assert_eq!(doc["model"].as_str(), Some("my-model"));
    }

    #[test]
    #[serial]
    fn shared_channel_legacy_orphan_can_be_edited_without_claiming_a_binding() {
        with_shared_test_home(|state, _| {
            let mut orphan = channel().to_codex_provider().unwrap();
            orphan.meta.as_mut().unwrap().shared_channel_id = None;
            let mut edited = orphan.clone();
            edited.settings_config["auth"]["OPENAI_API_KEY"] =
                serde_json::json!("fake-independent-key");
            ProviderService::validate_shared_child_update(
                state,
                &AppType::Codex,
                Some(&orphan),
                &mut edited,
            )
            .unwrap();
            assert!(edited.meta.as_ref().unwrap().shared_channel_id.is_none());
            edited.meta.as_mut().unwrap().shared_channel_id = Some("test-channel".into());
            assert!(ProviderService::validate_shared_child_update(
                state,
                &AppType::Codex,
                Some(&orphan),
                &mut edited
            )
            .is_err());
        });
    }

    #[test]
    #[serial]
    fn shared_channel_switch_backfill_keeps_live_models_but_restores_shared_connection() {
        with_shared_test_home(|state, _| {
            crate::settings::reload_settings().unwrap();
            let original = channel();
            ProviderService::save_shared_channel(state, original.clone()).unwrap();
            let linked_id = "universal-codex-test-channel";
            let mut other = original.to_codex_provider().unwrap();
            other.id = "synthetic-unlinked".into();
            other.meta.as_mut().unwrap().shared_channel_id = None;
            state.db.save_provider("codex", &other).unwrap();
            ProviderService::switch(state, AppType::Codex, linked_id).unwrap();
            let path = crate::codex_config::get_codex_config_path();
            let mut live: toml_edit::DocumentMut =
                std::fs::read_to_string(&path).unwrap().parse().unwrap();
            let provider_id = codex_provider_id(&live).to_string();
            live["model"] = toml_edit::value("changed-in-client");
            live["approval_policy"] = toml_edit::value("never");
            live["model_providers"][&provider_id]["base_url"] =
                toml_edit::value("https://external-change.example/v1");
            live["model_providers"][&provider_id]["experimental_bearer_token"] =
                toml_edit::value("fake-external-key");
            std::fs::write(&path, live.to_string()).unwrap();
            let result = ProviderService::switch(state, AppType::Codex, &other.id).unwrap();
            assert!(result.warnings.is_empty());
            let stored = state
                .db
                .get_provider_by_id(linked_id, "codex")
                .unwrap()
                .unwrap();
            let config = codex_document(&stored).unwrap();
            assert_eq!(config["model"].as_str(), Some("changed-in-client"));
            assert_eq!(config["approval_policy"].as_str(), Some("never"));
            assert_eq!(
                config["model_providers"][&provider_id]["base_url"].as_str(),
                Some("https://synthetic.example/v1")
            );
            assert_eq!(
                config["model_providers"][&provider_id]["requires_openai_auth"].as_bool(),
                Some(true)
            );
            assert!(!stored
                .settings_config
                .to_string()
                .contains("fake-external-key"));
            assert_eq!(
                stored.settings_config["auth"]["OPENAI_API_KEY"],
                original.api_key
            );
            let mut edited = stored.clone();
            edited.notes = Some("Still editable".into());
            ProviderService::update(state, AppType::Codex, None, edited).unwrap();
            ProviderService::switch(state, AppType::Codex, linked_id).unwrap();
            let live = std::fs::read_to_string(path).unwrap();
            assert!(live.contains("changed-in-client"));
            assert!(!live.contains("external-change.example"));
            crate::settings::set_current_provider(&AppType::Codex, None).unwrap();
        });
    }

    #[test]
    #[serial]
    fn shared_channel_retry_reads_latest_master_after_acquiring_switch_locks() {
        with_shared_test_home(|state, _| {
            let original = channel();
            ProviderService::save_shared_channel(state, original.clone()).unwrap();
            let guard =
                futures::executor::block_on(state.proxy_service.lock_switch_for_app("claude"));
            std::thread::scope(|scope| {
                let (started_tx, started_rx) = std::sync::mpsc::channel();
                let (done_tx, done_rx) = std::sync::mpsc::channel();
                let retry_id = original.id.clone();
                let handle = scope.spawn(move || {
                    started_tx.send(()).unwrap();
                    let result = ProviderService::resync_shared_channel(state, &retry_id);
                    done_tx.send(()).unwrap();
                    result
                });
                started_rx.recv().unwrap();
                assert!(done_rx
                    .recv_timeout(std::time::Duration::from_millis(50))
                    .is_err());
                // Simulate the rotation holding the same lock before retry proceeds.
                let mut latest = original.clone();
                latest.api_key = "fake-latest-shared-key".into();
                state.db.save_universal_provider(&latest).unwrap();
                drop(guard);
                assert!(handle.join().unwrap().unwrap().failed_apps.is_empty());
            });
            assert_eq!(
                state
                    .db
                    .get_universal_provider(&original.id)
                    .unwrap()
                    .unwrap()
                    .api_key,
                "fake-latest-shared-key"
            );
            assert_eq!(
                state
                    .db
                    .get_provider_by_id("universal-codex-test-channel", "codex")
                    .unwrap()
                    .unwrap()
                    .settings_config["auth"]["OPENAI_API_KEY"],
                "fake-latest-shared-key"
            );
        });
    }

    #[test]
    fn shared_channel_legacy_preview_preserves_protocol_without_private_metadata() {
        let mut channel = channel();
        channel.meta = Some(crate::provider::ProviderMeta {
            api_format: Some("openai_chat".into()),
            custom_user_agent: Some("fake-private-metadata".into()),
            ..Default::default()
        });
        let preview = ProviderService::preview_shared_channel(channel).unwrap();
        assert_eq!(
            codex_document(&preview["codex"]).unwrap()["model_providers"]["custom"]["wire_api"]
                .as_str(),
            Some("responses")
        );
        assert!(!serde_json::to_string(&preview)
            .unwrap()
            .contains("fake-private-metadata"));
    }

    #[test]
    fn shared_channel_origin_query_keeps_the_same_path_in_preview_and_saved_config() {
        let mut channel = channel();
        channel.base_url = "https://synthetic.example?token=fake-url-secret".into();
        let generated = channel.to_codex_provider().unwrap();
        let preview = ProviderService::preview_shared_channel(channel).unwrap();
        let doc = codex_document(&generated).unwrap();
        let preview_doc = codex_document(&preview["codex"]).unwrap();
        let original_url = url::Url::parse(
            doc["model_providers"]["custom"]["base_url"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        let preview_url = url::Url::parse(
            preview_doc["model_providers"]["custom"]["base_url"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(original_url.path(), "/v1");
        assert_eq!(preview_url.path(), original_url.path());
        assert_eq!(original_url.query(), Some("token=fake-url-secret"));
        assert!(!serde_json::to_string(&preview)
            .unwrap()
            .contains("fake-url-secret"));
    }

    #[test]
    #[serial]
    fn shared_channel_legacy_format_hydrates_url_only_and_missing_children_per_app() {
        with_shared_test_home(|state, _| {
            let mut channel = channel();
            channel.apps.gemini = true;
            channel.meta = Some(crate::provider::ProviderMeta {
                api_format: Some("openai_chat".into()),
                ..Default::default()
            });
            channel.connections.codex = Some(SharedChannelConnection {
                base_url: Some("https://synthetic.example/codex".into()),
                api_format: None,
            });
            state.db.save_universal_provider(&channel).unwrap();
            let loaded = ProviderService::get_universal(state, &channel.id)
                .unwrap()
                .unwrap();
            assert_eq!(
                loaded
                    .connections
                    .codex
                    .as_ref()
                    .unwrap()
                    .api_format
                    .as_deref(),
                Some("openai_chat")
            );
            assert_eq!(
                loaded.connections.codex.as_ref().unwrap().base_url,
                channel.connections.codex.as_ref().unwrap().base_url
            );
            assert_eq!(
                loaded
                    .connections
                    .claude
                    .as_ref()
                    .unwrap()
                    .api_format
                    .as_deref(),
                Some("openai_chat")
            );
            assert_eq!(
                loaded
                    .connections
                    .gemini
                    .as_ref()
                    .unwrap()
                    .api_format
                    .as_deref(),
                Some("gemini_native")
            );
            assert_eq!(
                channel
                    .to_gemini_provider()
                    .unwrap()
                    .meta
                    .unwrap()
                    .api_format
                    .as_deref(),
                Some("gemini_native")
            );
            ProviderService::save_shared_channel(state, loaded.clone()).unwrap();
            let listed = ProviderService::list_universal(state)
                .unwrap()
                .remove(&channel.id)
                .unwrap();
            assert_eq!(
                listed.connections.codex.unwrap().api_format.as_deref(),
                Some("openai_chat")
            );
            let mut explicit_native = loaded;
            explicit_native
                .connections
                .codex
                .as_mut()
                .unwrap()
                .api_format = Some("openai_responses".into());
            ProviderService::save_shared_channel(state, explicit_native).unwrap();
            let stored = state
                .db
                .get_provider_by_id("universal-codex-test-channel", "codex")
                .unwrap()
                .unwrap();
            assert_eq!(
                stored.meta.unwrap().api_format.as_deref(),
                Some("openai_responses")
            );
        });
    }

    #[test]
    #[serial]
    fn shared_channel_codex_upstream_protocol_never_changes_client_responses_wire() {
        with_shared_test_home(|state, _| {
            crate::settings::reload_settings().unwrap();
            for format in ["openai_chat", "anthropic"] {
                let mut channel = channel();
                channel.apps.claude = false;
                channel.connections.codex = Some(SharedChannelConnection {
                    base_url: None,
                    api_format: Some(format.into()),
                });
                let preview = ProviderService::preview_shared_channel(channel.clone()).unwrap();
                assert_eq!(
                    codex_document(&preview["codex"]).unwrap()["model_providers"]["custom"]
                        ["wire_api"]
                        .as_str(),
                    Some("responses")
                );
                assert_eq!(
                    preview["codex"]
                        .meta
                        .as_ref()
                        .unwrap()
                        .api_format
                        .as_deref(),
                    Some(format)
                );
                ProviderService::save_shared_channel(state, channel.clone()).unwrap();
                let id = "universal-codex-test-channel";
                let stored = state.db.get_provider_by_id(id, "codex").unwrap().unwrap();
                assert_eq!(
                    stored.meta.as_ref().unwrap().api_format.as_deref(),
                    Some(format)
                );
                assert_eq!(
                    codex_document(&stored).unwrap()["model_providers"]["custom"]["wire_api"]
                        .as_str(),
                    Some("responses")
                );
                use crate::proxy::providers::{
                    should_convert_codex_responses_to_anthropic,
                    should_convert_codex_responses_to_chat,
                };
                assert_eq!(
                    should_convert_codex_responses_to_chat(&stored, "/v1/responses"),
                    format == "openai_chat"
                );
                assert_eq!(
                    should_convert_codex_responses_to_anthropic(&stored, "/v1/responses"),
                    format == "anthropic"
                );
                ProviderService::switch(state, AppType::Codex, id).unwrap();
                let path = crate::codex_config::get_codex_config_path();
                let mut live: toml_edit::DocumentMut =
                    std::fs::read_to_string(&path).unwrap().parse().unwrap();
                let provider_id = codex_provider_id(&live).to_string();
                assert_eq!(
                    live["model_providers"][&provider_id]["wire_api"].as_str(),
                    Some("responses")
                );
                let mut edited = stored.clone();
                edited.notes = Some("Conversion child remains editable".into());
                ProviderService::update(state, AppType::Codex, None, edited).unwrap();
                // Seed the same proxy-owned live/backup state without starting a listener.
                futures::executor::block_on(
                    state
                        .db
                        .save_live_backup("codex", &stored.settings_config.to_string()),
                )
                .unwrap();
                live["model_providers"][&provider_id]["base_url"] =
                    toml_edit::value("http://127.0.0.1:15731/v1");
                live["model_providers"][&provider_id]["experimental_bearer_token"] =
                    toml_edit::value("PROXY_MANAGED");
                std::fs::write(&path, live.to_string()).unwrap();
                channel.api_key = "fake-rotated-during-takeover".into();
                let result = ProviderService::save_shared_channel(state, channel).unwrap();
                assert!(result.failed_apps.is_empty());
                let backup = futures::executor::block_on(state.db.get_live_backup("codex"))
                    .unwrap()
                    .unwrap();
                let backup: Value = serde_json::from_str(&backup.original_config).unwrap();
                let backup_config: toml_edit::DocumentMut =
                    backup["config"].as_str().unwrap().parse().unwrap();
                let backup_provider = codex_provider_id(&backup_config);
                assert_eq!(
                    backup_config["model_providers"][backup_provider]["wire_api"].as_str(),
                    Some("responses")
                );
                futures::executor::block_on(state.proxy_service.stop_with_restore()).unwrap();
                let restored: toml_edit::DocumentMut =
                    std::fs::read_to_string(path).unwrap().parse().unwrap();
                let restored_provider = codex_provider_id(&restored);
                assert_eq!(
                    restored["model_providers"][restored_provider]["wire_api"].as_str(),
                    Some("responses")
                );
                assert!(!restored.to_string().contains("127.0.0.1:15731"));
                assert!(restored
                    .to_string()
                    .contains("fake-rotated-during-takeover"));
                let stored = state.db.get_provider_by_id(id, "codex").unwrap().unwrap();
                assert_eq!(stored.meta.unwrap().api_format.as_deref(), Some(format));
                crate::settings::set_current_provider(&AppType::Codex, None).unwrap();
            }
        });
    }

    #[test]
    #[serial]
    fn shared_channel_stale_backup_does_not_hide_current_live_rotation() {
        with_shared_test_home(|state, _| {
            let mut channel = channel();
            channel.apps.codex = false;
            ProviderService::save_shared_channel(state, channel.clone()).unwrap();
            ProviderService::switch(state, AppType::Claude, "universal-claude-test-channel")
                .unwrap();
            let child = channel.to_claude_provider().unwrap();
            futures::executor::block_on(
                state
                    .db
                    .save_live_backup("claude", &child.settings_config.to_string()),
            )
            .unwrap();
            assert!(!futures::executor::block_on(
                state.proxy_service.is_running()
            ));
            assert!(
                !futures::executor::block_on(state.db.get_proxy_config_for_app("claude"))
                    .unwrap()
                    .enabled
            );
            channel.api_key = "fake-current-rotated-key".into();
            let result = ProviderService::save_shared_channel(state, channel).unwrap();
            assert!(result.failed_apps.is_empty());
            let live: Value =
                crate::config::read_json_file(&crate::config::get_claude_settings_path()).unwrap();
            assert_eq!(
                live["env"]["ANTHROPIC_AUTH_TOKEN"],
                "fake-current-rotated-key"
            );
            assert_eq!(
                live["env"]["ANTHROPIC_BASE_URL"],
                "https://synthetic.example"
            );
            let backup = futures::executor::block_on(state.db.get_live_backup("claude"))
                .unwrap()
                .unwrap();
            let backup: Value = serde_json::from_str(&backup.original_config).unwrap();
            assert_eq!(
                backup["env"]["ANTHROPIC_AUTH_TOKEN"],
                "fake-current-rotated-key"
            );
        });
    }

    #[test]
    #[serial]
    fn shared_channel_common_config_keeps_preferences_without_owning_connection() {
        with_shared_test_home(|state, _| {
            let mut channel = channel();
            ProviderService::save_shared_channel(state, channel.clone()).unwrap();
            for app in [AppType::Claude, AppType::Codex] {
                let id = format!("universal-{}-test-channel", app.as_str());
                ProviderService::switch(state, app.clone(), &id).unwrap();
                let mut child = state
                    .db
                    .get_provider_by_id(&id, app.as_str())
                    .unwrap()
                    .unwrap();
                child.meta.as_mut().unwrap().common_config_enabled = Some(true);
                let snippet = if app == AppType::Claude {
                    serde_json::json!({"env": {
                        "ANTHROPIC_BASE_URL": "https://synthetic.example",
                        "ANTHROPIC_AUTH_TOKEN": "sk-fake-before",
                        "SYNTHETIC_SHARED_PREF": "keep"
                    }})
                    .to_string()
                } else {
                    "model_provider = 'custom'\n[model_providers.custom]\nbase_url = 'https://synthetic.example/v1'\nwire_api = 'responses'\nrequires_openai_auth = true\n".into()
                };
                // Identical snippet fields must not be stripped from the DB child.
                state
                    .db
                    .set_config_snippet(app.as_str(), Some(snippet))
                    .unwrap();
                ProviderService::update(state, app.clone(), None, child).unwrap();
                let stored = state
                    .db
                    .get_provider_by_id(&id, app.as_str())
                    .unwrap()
                    .unwrap();
                let mut editable = stored.clone();
                ProviderService::validate_shared_child_update(
                    state,
                    &app,
                    Some(&stored),
                    &mut editable,
                )
                .unwrap();
                let conflicting = if app == AppType::Claude {
                    serde_json::json!({"env": {
                        "ANTHROPIC_BASE_URL": "https://wrong.example",
                        "ANTHROPIC_AUTH_TOKEN": "fake-common-key",
                        "ANTHROPIC_API_KEY": "fake-common-alias",
                        "SYNTHETIC_SHARED_PREF": "keep"
                    }})
                    .to_string()
                } else {
                    "model_provider = 'wrong'\napproval_policy = 'never'\n[model_providers.custom]\nbase_url = 'https://wrong.example'\nwire_api = 'chat'\nexperimental_bearer_token = 'fake-common-key'\nenv_key = 'FAKE_COMMON_KEY'\n[model_providers.custom.http_headers]\nAuthorization = 'Bearer fake-common-key'\n[model_providers.wrong]\nname = 'Other'\nbase_url = 'https://wrong.example'\nwire_api = 'responses'\n".into()
                };
                state
                    .db
                    .set_config_snippet(app.as_str(), Some(conflicting))
                    .unwrap();
                ProviderService::update(state, app.clone(), None, editable).unwrap();
            }
            channel.api_key = "fake-shared-rotated-key".into();
            let result = ProviderService::save_shared_channel(state, channel).unwrap();
            assert!(result.failed_apps.is_empty());
            use crate::proxy::providers::{ClaudeAdapter, CodexAdapter, ProviderAdapter};
            for app in [AppType::Claude, AppType::Codex] {
                let id = format!("universal-{}-test-channel", app.as_str());
                let mut stored = state
                    .db
                    .get_provider_by_id(&id, app.as_str())
                    .unwrap()
                    .unwrap();
                let actual_key = if app == AppType::Claude {
                    ClaudeAdapter::new().extract_auth(&stored).unwrap().api_key
                } else {
                    CodexAdapter::new().extract_auth(&stored).unwrap().api_key
                };
                assert_eq!(actual_key, "fake-shared-rotated-key");
                stored.settings_config =
                    live::build_effective_settings_with_common_config(&state.db, &app, &stored)
                        .unwrap();
                let effective_key = if app == AppType::Claude {
                    ClaudeAdapter::new().extract_auth(&stored).unwrap().api_key
                } else {
                    CodexAdapter::new().extract_auth(&stored).unwrap().api_key
                };
                assert_eq!(effective_key, "fake-shared-rotated-key");
                if app == AppType::Claude {
                    let actual: Value =
                        crate::config::read_json_file(&crate::config::get_claude_settings_path())
                            .unwrap();
                    assert_eq!(
                        actual["env"]["ANTHROPIC_AUTH_TOKEN"],
                        "fake-shared-rotated-key"
                    );
                    assert_eq!(
                        actual["env"]["ANTHROPIC_BASE_URL"],
                        "https://synthetic.example"
                    );
                    assert_eq!(actual["env"]["SYNTHETIC_SHARED_PREF"], "keep");
                    assert!(actual["env"].get("ANTHROPIC_API_KEY").is_none());
                } else {
                    let actual =
                        std::fs::read_to_string(crate::codex_config::get_codex_config_path())
                            .unwrap();
                    let actual: toml_edit::DocumentMut = actual.parse().unwrap();
                    assert_eq!(actual["model_provider"].as_str(), Some("custom"));
                    assert_eq!(actual["approval_policy"].as_str(), Some("never"));
                    assert_eq!(
                        actual["model_providers"]["custom"]["base_url"].as_str(),
                        Some("https://synthetic.example/v1")
                    );
                    assert_eq!(
                        actual["model_providers"]["custom"]["wire_api"].as_str(),
                        Some("responses")
                    );
                    assert_eq!(
                        actual["model_providers"]["custom"]["experimental_bearer_token"].as_str(),
                        Some("fake-shared-rotated-key")
                    );
                    assert!(actual["model_providers"]["custom"].get("env_key").is_none());
                    assert!(actual["model_providers"]["custom"]["http_headers"]
                        .get("Authorization")
                        .is_none());
                }
            }
        });
    }

    #[test]
    #[serial]
    fn shared_channel_legacy_common_config_migration_retains_connection_and_editability() {
        with_shared_test_home(|state, _| {
            let channel = channel();
            ProviderService::save_shared_channel(state, channel.clone()).unwrap();
            use crate::proxy::providers::{ClaudeAdapter, CodexAdapter, ProviderAdapter};
            for legacy_binding in [false, true] {
                for app in [AppType::Claude, AppType::Codex] {
                    let mut provider = child(&channel, &app).unwrap();
                    if legacy_binding {
                        provider.meta.as_mut().unwrap().shared_channel_id = None;
                    }
                    let snippet = if app == AppType::Claude {
                        provider.settings_config["env"]["SYNTHETIC_COMMON_PREF"] =
                            serde_json::json!("inherited");
                        provider.settings_config["env"]["SYNTHETIC_LOCAL_PREF"] =
                            serde_json::json!("keep");
                        serde_json::json!({"env": {
                            "ANTHROPIC_AUTH_TOKEN": "sk-fake-before",
                            "ANTHROPIC_BASE_URL": "https://synthetic.example",
                            "SYNTHETIC_COMMON_PREF": "inherited"
                        }})
                        .to_string()
                    } else {
                        let mut document = codex_document(&provider).unwrap();
                        document["approval_policy"] = toml_edit::value("never");
                        document["sandbox_mode"] = toml_edit::value("workspace-write");
                        provider.settings_config["config"] =
                            serde_json::json!(document.to_string());
                        "approval_policy = 'never'\nmodel_provider = 'custom'\n[model_providers.custom]\nbase_url = 'https://synthetic.example/v1'\nwire_api = 'responses'\nrequires_openai_auth = true\n".into()
                    };
                    state.db.save_provider(app.as_str(), &provider).unwrap();
                    state
                        .db
                        .set_config_snippet(app.as_str(), Some(snippet.clone()))
                        .unwrap();
                    ProviderService::migrate_legacy_common_config_usage(
                        state,
                        app.clone(),
                        &snippet,
                    )
                    .unwrap();
                    let migrated = state
                        .db
                        .get_provider_by_id(&provider.id, app.as_str())
                        .unwrap()
                        .unwrap();
                    assert_eq!(
                        migrated.meta.as_ref().unwrap().common_config_enabled,
                        Some(true)
                    );
                    if app == AppType::Claude {
                        assert_eq!(
                            ClaudeAdapter::new()
                                .extract_auth(&migrated)
                                .unwrap()
                                .api_key,
                            "sk-fake-before"
                        );
                        assert_eq!(
                            ClaudeAdapter::new().extract_base_url(&migrated).unwrap(),
                            "https://synthetic.example"
                        );
                        assert!(migrated.settings_config["env"]
                            .get("SYNTHETIC_COMMON_PREF")
                            .is_none());
                        assert_eq!(
                            migrated.settings_config["env"]["SYNTHETIC_LOCAL_PREF"],
                            "keep"
                        );
                    } else {
                        assert_eq!(
                            CodexAdapter::new().extract_auth(&migrated).unwrap().api_key,
                            "sk-fake-before"
                        );
                        assert_eq!(
                            CodexAdapter::new().extract_base_url(&migrated).unwrap(),
                            "https://synthetic.example/v1"
                        );
                        let document = codex_document(&migrated).unwrap();
                        assert_eq!(document["model_provider"].as_str(), Some("custom"));
                        assert_eq!(
                            document["model_providers"]["custom"]["wire_api"].as_str(),
                            Some("responses")
                        );
                        assert!(document.get("approval_policy").is_none());
                        assert_eq!(document["sandbox_mode"].as_str(), Some("workspace-write"));
                    }
                    let effective = live::build_effective_settings_with_common_config(
                        &state.db, &app, &migrated,
                    )
                    .unwrap();
                    if app == AppType::Claude {
                        assert_eq!(effective["env"]["SYNTHETIC_COMMON_PREF"], "inherited");
                    } else {
                        let document: toml_edit::DocumentMut =
                            effective["config"].as_str().unwrap().parse().unwrap();
                        assert_eq!(document["approval_policy"].as_str(), Some("never"));
                    }
                    let mut edited = migrated;
                    edited.notes = Some("After legacy migration".into());
                    ProviderService::update(state, app.clone(), None, edited).unwrap();
                    let saved = state
                        .db
                        .get_provider_by_id(&provider.id, app.as_str())
                        .unwrap()
                        .unwrap();
                    assert_eq!(saved.notes.as_deref(), Some("After legacy migration"));
                    assert_eq!(
                        saved.meta.unwrap().shared_channel_id.as_deref(),
                        Some("test-channel")
                    );
                }
            }
        });
    }
}
