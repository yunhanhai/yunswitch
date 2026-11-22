//! 动态模型目录命令层

use crate::services::model_catalog::{FetchCatalogParams, ModelCatalogSnapshot};
use crate::store::AppState;
use std::collections::BTreeMap;
use tauri::State;

#[tauri::command(rename_all = "camelCase")]
// Keep the established flat Tauri IPC parameters compatible with the renderer.
#[allow(clippy::too_many_arguments)]
pub async fn get_model_catalog(
    state: State<'_, AppState>,
    base_url: String,
    api_key: String,
    is_full_url: Option<bool>,
    models_url: Option<String>,
    custom_user_agent: Option<String>,
    api_format: Option<String>,
    request_headers: Option<BTreeMap<String, String>>,
) -> Result<ModelCatalogSnapshot, String> {
    let params = FetchCatalogParams {
        base_url,
        api_key,
        is_full_url: is_full_url.unwrap_or(false),
        models_url_override: models_url,
        custom_user_agent,
        api_format,
        request_headers,
    };
    crate::services::model_catalog::fetch_catalog_for_provider(state.db.clone(), params, false)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
// Keep the established flat Tauri IPC parameters compatible with the renderer.
#[allow(clippy::too_many_arguments)]
pub async fn refresh_model_catalog(
    state: State<'_, AppState>,
    base_url: String,
    api_key: String,
    is_full_url: Option<bool>,
    models_url: Option<String>,
    custom_user_agent: Option<String>,
    api_format: Option<String>,
    request_headers: Option<BTreeMap<String, String>>,
) -> Result<ModelCatalogSnapshot, String> {
    let params = FetchCatalogParams {
        base_url,
        api_key,
        is_full_url: is_full_url.unwrap_or(false),
        models_url_override: models_url,
        custom_user_agent,
        api_format,
        request_headers,
    };
    crate::services::model_catalog::fetch_catalog_for_provider(state.db.clone(), params, true)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
// Keep the established flat Tauri IPC arguments compatible with old renderers.
#[allow(clippy::too_many_arguments)]
pub async fn get_model_catalog_cache_status(
    base_url: String,
    api_key: Option<String>,
    is_full_url: Option<bool>,
    models_url: Option<String>,
    custom_user_agent: Option<String>,
    api_format: Option<String>,
    request_headers: Option<BTreeMap<String, String>>,
) -> Result<Option<ModelCatalogSnapshot>, String> {
    let params = FetchCatalogParams {
        base_url,
        api_key: api_key.unwrap_or_default(),
        is_full_url: is_full_url.unwrap_or(false),
        models_url_override: models_url,
        custom_user_agent,
        api_format,
        request_headers,
    };
    let key = crate::services::model_catalog::provider_key(&params);
    crate::services::model_catalog::cached_catalog_status(&key).map_err(|e| e.to_string())
}
