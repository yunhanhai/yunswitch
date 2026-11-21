//! 动态模型目录服务（对标 Magpie 的 Real model lists + models.dev）
//!
//! 职责：
//! - 厂商 `GET /v1/models` 拉取（走 `services::model_fetch` 的 URL 候选与 header 策略）
//! - `models.dev` 兜底补充（复用 `services::model_pricing` 的同步状态与本地缓存）
//! - 统一缓存：`~/.cc-switch/model-catalog.json`（TTL 6h，`MODEL_CATALOG_FILE_LOCK` 保护）
//! - 合并策略：厂商列表为准，`models.dev` 补充缺失项；去重与排序由本模块负责
//! - 后台刷新：过期后下一次读取触发后台任务，失败不阻塞调用方
//!
//! 设计约束：
//! - 复用 `model_pricing` 的 `models_dev_sync` 配置与文件锁，不引入新的同步协议
//! - 缓存命中走内存 + 文件，避免每次打开 Provider 详情都打网络
//! - 过期目录先返回，并在后台单飞刷新；失败保留可用目录并退避

use crate::config::{atomic_write, get_app_config_dir};
use crate::error::AppError;
use crate::services::model_fetch::FetchedModel;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const MODEL_CATALOG_FILE_NAME: &str = "model-catalog.json";
const MODEL_CATALOG_TTL_SECS: u64 = 6 * 60 * 60; // 6 小时
const MODEL_CATALOG_VERSION: u32 = 2;
const MODEL_CATALOG_RETRY_SECS: u64 = 60;
const MODEL_CATALOG_RETENTION_SECS: u64 = 30 * 24 * 60 * 60;
const MODEL_CATALOG_MAX_SNAPSHOTS: usize = 256;

fn is_false(value: &bool) -> bool {
    !value
}

static MODEL_CATALOG_FILE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static MODEL_CATALOG_REFRESHES: OnceLock<Mutex<BTreeSet<String>>> = OnceLock::new();

fn file_lock() -> &'static Mutex<()> {
    MODEL_CATALOG_FILE_LOCK.get_or_init(|| Mutex::new(()))
}

/// 动态模型目录项（统一视图）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogModel {
    pub id: String,
    pub display_name: String,
    pub source: CatalogSource,
    pub owned_by: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CatalogSource {
    Vendor,
    ModelsDev,
    Both,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalogSnapshot {
    pub version: u32,
    pub fetched_at_secs: u64,
    pub provider_key: String,
    pub models: Vec<CatalogModel>,
    pub vendor_error: Option<String>,
    #[serde(default)]
    pub last_attempt_at_secs: u64,
    #[serde(default, skip_serializing_if = "is_false")]
    pub refreshing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelCatalogFile {
    version: u32,
    snapshots: HashMap<String, ModelCatalogSnapshot>,
}

impl Default for ModelCatalogFile {
    fn default() -> Self {
        Self {
            version: MODEL_CATALOG_VERSION,
            snapshots: HashMap::new(),
        }
    }
}

pub fn model_catalog_file_path() -> PathBuf {
    get_app_config_dir().join(MODEL_CATALOG_FILE_NAME)
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_secs()
}

fn is_expired(snapshot: &ModelCatalogSnapshot) -> bool {
    snapshot.vendor_error.is_some()
        || now_secs().saturating_sub(snapshot.fetched_at_secs) >= MODEL_CATALOG_TTL_SECS
}

fn cache_is_in_retry_backoff(snapshot: &ModelCatalogSnapshot, now: u64) -> bool {
    let attempted_recently = snapshot.last_attempt_at_secs > 0
        && now.saturating_sub(snapshot.last_attempt_at_secs) < MODEL_CATALOG_RETRY_SECS;
    attempted_recently
        && (snapshot.vendor_error.is_some()
            || snapshot.last_attempt_at_secs > snapshot.fetched_at_secs)
}

fn snapshot_changed_since(
    previous: Option<&ModelCatalogSnapshot>,
    current: &ModelCatalogSnapshot,
) -> bool {
    let Some(previous) = previous else {
        return true;
    };
    previous.fetched_at_secs != current.fetched_at_secs
        || previous.last_attempt_at_secs != current.last_attempt_at_secs
        || previous.vendor_error != current.vendor_error
        || previous.models != current.models
}

pub(crate) fn provider_key(params: &FetchCatalogParams) -> String {
    // Cache identity follows the complete model-list request, but persistent
    // cache files contain only a digest. Never persist URLs, API keys, custom
    // header values, or endpoint query strings as a cache key.
    let headers = params.request_headers.as_ref();
    let api_key = if params.api_key.is_empty() {
        None
    } else {
        Some(Sha256::digest(params.api_key.as_bytes()).to_vec())
    };
    let identity = serde_json::to_vec(&(
        params.base_url.trim().trim_end_matches('/'),
        params.is_full_url,
        params.models_url_override.as_deref().map(str::trim),
        params
            .api_format
            .as_deref()
            .map(|value| value.trim().to_ascii_lowercase()),
        api_key,
        params.custom_user_agent.as_deref().map(str::trim),
        headers,
    ))
    .expect("model catalog cache identity is serializable");
    format!("v{MODEL_CATALOG_VERSION}-{:x}", Sha256::digest(identity))
}

fn refresh_set() -> &'static Mutex<BTreeSet<String>> {
    MODEL_CATALOG_REFRESHES.get_or_init(|| Mutex::new(BTreeSet::new()))
}

fn refreshing(key: &str) -> bool {
    refresh_set()
        .lock()
        .map(|set| set.contains(key))
        .unwrap_or(false)
}

fn finish_refresh(key: &str) {
    if let Ok(mut set) = refresh_set().lock() {
        set.remove(key);
    }
}

struct RefreshLease(String);

impl RefreshLease {
    fn claim(key: &str) -> Option<Self> {
        refresh_set()
            .lock()
            .ok()
            .and_then(|mut set| set.insert(key.to_owned()).then(|| Self(key.to_owned())))
    }
}

impl Drop for RefreshLease {
    fn drop(&mut self) {
        finish_refresh(&self.0);
    }
}

fn prune_snapshots(snapshots: &mut HashMap<String, ModelCatalogSnapshot>, now: u64) {
    snapshots.retain(|_, snapshot| {
        now.saturating_sub(snapshot.last_attempt_at_secs.max(snapshot.fetched_at_secs))
            < MODEL_CATALOG_RETENTION_SECS
    });
    if snapshots.len() > MODEL_CATALOG_MAX_SNAPSHOTS {
        let mut oldest: Vec<_> = snapshots
            .iter()
            .map(|(key, snapshot)| {
                (
                    key.clone(),
                    snapshot.last_attempt_at_secs.max(snapshot.fetched_at_secs),
                )
            })
            .collect();
        oldest.sort_unstable();
        for (key, _) in oldest
            .into_iter()
            .take(snapshots.len().saturating_sub(MODEL_CATALOG_MAX_SNAPSHOTS))
        {
            snapshots.remove(&key);
        }
    }
}

/// 合并厂商列表与 `models.dev` 补充列表。
///
/// - 厂商列表为准：同 `id` 的模型优先标记为 `Both`（两端都有）
/// - `models.dev` 仅补充厂商未覆盖的项
pub fn merge_catalog_models(
    vendor: Vec<FetchedModel>,
    models_dev: Vec<CatalogModel>,
) -> Vec<CatalogModel> {
    let mut by_id: BTreeMap<String, CatalogModel> = BTreeMap::new();

    for model in models_dev {
        by_id.insert(
            model.id.clone(),
            CatalogModel {
                source: CatalogSource::ModelsDev,
                ..model
            },
        );
    }

    for fetched in vendor {
        let entry = by_id
            .entry(fetched.id.clone())
            .or_insert_with(|| CatalogModel {
                id: fetched.id.clone(),
                display_name: fetched.id.clone(),
                source: CatalogSource::Vendor,
                owned_by: fetched.owned_by.clone(),
            });
        // 厂商覆盖：来源升级为 Both，owned_by 以厂商为准
        entry.source = match entry.source {
            CatalogSource::ModelsDev => CatalogSource::Both,
            _ => CatalogSource::Vendor,
        };
        if fetched.owned_by.is_some() {
            entry.owned_by = fetched.owned_by;
        }
        if entry.display_name.is_empty() {
            entry.display_name = entry.id.clone();
        }
    }

    let mut models: Vec<CatalogModel> = by_id.into_values().collect();
    // 已按 BTreeMap 排序，无需二次排序
    let _ = &mut models;
    models
}

fn read_file_unlocked() -> Result<Option<ModelCatalogFile>, AppError> {
    let path = model_catalog_file_path();
    if !path.exists() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(&path).map_err(|e| AppError::io(&path, e))?;
    let file: ModelCatalogFile =
        serde_json::from_str(&content).map_err(|e| AppError::json(&path, e))?;
    if file.version > MODEL_CATALOG_VERSION {
        return Err(AppError::Config(format!(
            "model-catalog.json version {} is newer than supported version {}",
            file.version, MODEL_CATALOG_VERSION
        )));
    }
    if file.version < MODEL_CATALOG_VERSION {
        // Version 1 stored the raw endpoint as its key and did not include
        // the model-list override or auth identity. Its entries are unsafe
        // to reuse; a successful fetch writes the new digest-keyed format.
        let migrated = ModelCatalogFile::default();
        write_file_unlocked(&migrated)?;
        return Ok(Some(migrated));
    }
    if file.snapshots.values().any(|snapshot| snapshot.refreshing) {
        let mut recovered = file;
        for snapshot in recovered.snapshots.values_mut() {
            snapshot.refreshing = false;
        }
        write_file_unlocked(&recovered)?;
        return Ok(Some(recovered));
    }
    Ok(Some(file))
}

fn write_file_unlocked(file: &ModelCatalogFile) -> Result<(), AppError> {
    let path = model_catalog_file_path();
    let mut data = serde_json::to_vec_pretty(file)
        .map_err(|e| AppError::Config(format!("序列化模型目录缓存失败: {e}")))?;
    data.push(b'\n');
    atomic_write(&path, &data)
}

/// 从本地定价/models.dev 配置中提取兜底模型列表。
///
/// 当前 `model_pricing` 表的 `model_id` 即为兜底来源；未来可替换为 models.dev 的完整 API 拉取。
/// 直接用 `db.conn` 查询，避免依赖不存在的 `get_all_model_pricing` 封装。
pub fn load_models_dev_fallback(
    db: &crate::database::Database,
) -> Result<Vec<CatalogModel>, AppError> {
    let conn = db
        .conn
        .lock()
        .map_err(|e| AppError::Database(format!("模型定价读取锁失败: {e}")))?;
    let mut stmt = conn
        .prepare("SELECT model_id, display_name FROM model_pricing ORDER BY model_id")
        .map_err(|e| AppError::Database(format!("读取模型定价失败: {e}")))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| AppError::Database(format!("读取模型定价失败: {e}")))?;
    let mut seen = BTreeSet::new();
    let mut models = Vec::new();
    for row in rows {
        let (model_id, display_name) =
            row.map_err(|e| AppError::Database(format!("读取模型定价失败: {e}")))?;
        if seen.insert(model_id.clone()) {
            models.push(CatalogModel {
                id: model_id,
                display_name,
                source: CatalogSource::ModelsDev,
                owned_by: None,
            });
        }
    }
    Ok(models)
}

pub fn get_cached_catalog(
    provider_key_str: &str,
) -> Result<Option<ModelCatalogSnapshot>, AppError> {
    let _guard = file_lock()
        .lock()
        .map_err(|e| AppError::Config(format!("模型目录文件锁失败: {e}")))?;
    let file = match read_file_unlocked()? {
        Some(file) => file,
        None => return Ok(None),
    };
    Ok(file.snapshots.get(provider_key_str).cloned())
}

pub(crate) fn cached_catalog_status(
    provider_key: &str,
) -> Result<Option<ModelCatalogSnapshot>, AppError> {
    let mut snapshot = get_cached_catalog(provider_key)?;
    if let Some(snapshot) = &mut snapshot {
        snapshot.refreshing = refreshing(provider_key);
    }
    Ok(snapshot)
}

pub fn put_cached_catalog(mut snapshot: ModelCatalogSnapshot) -> Result<(), AppError> {
    // The single-flight marker is process-local state. The cached timestamp
    // and contents persist, but an interrupted process must never leave a
    // serialized "refresh in progress" marker behind.
    snapshot.refreshing = false;
    let _guard = file_lock()
        .lock()
        .map_err(|e| AppError::Config(format!("模型目录文件锁失败: {e}")))?;
    let mut file = read_file_unlocked()?.unwrap_or_default();
    file.version = MODEL_CATALOG_VERSION;
    file.snapshots
        .insert(snapshot.provider_key.clone(), snapshot);
    prune_snapshots(&mut file.snapshots, now_secs());
    write_file_unlocked(&file)
}

#[derive(Debug, Clone)]
pub struct FetchCatalogParams {
    pub base_url: String,
    pub api_key: String,
    pub is_full_url: bool,
    pub models_url_override: Option<String>,
    pub custom_user_agent: Option<String>,
    pub api_format: Option<String>,
    pub request_headers: Option<BTreeMap<String, String>>,
}

fn build_snapshot(
    key: &str,
    fetched_at_secs: u64,
    models_dev: Vec<CatalogModel>,
    vendor_result: Result<Vec<FetchedModel>, String>,
    stale: Option<ModelCatalogSnapshot>,
) -> ModelCatalogSnapshot {
    match vendor_result {
        Ok(vendor) => ModelCatalogSnapshot {
            version: MODEL_CATALOG_VERSION,
            fetched_at_secs,
            provider_key: key.to_owned(),
            models: merge_catalog_models(vendor, models_dev),
            vendor_error: None,
            last_attempt_at_secs: fetched_at_secs,
            refreshing: false,
        },
        Err(error) => {
            if let Some(mut stale) = stale {
                // Like Magpie's catalog sync, a failed refresh does not
                // replace known-good model data with an incomplete fallback.
                stale.vendor_error = Some(error);
                stale.last_attempt_at_secs = fetched_at_secs;
                stale.refreshing = false;
                return stale;
            }
            ModelCatalogSnapshot {
                version: MODEL_CATALOG_VERSION,
                fetched_at_secs,
                provider_key: key.to_owned(),
                models: merge_catalog_models(Vec::new(), models_dev),
                vendor_error: Some(error),
                last_attempt_at_secs: fetched_at_secs,
                refreshing: false,
            }
        }
    }
}

async fn refresh_catalog(
    db: &crate::database::Database,
    params: &FetchCatalogParams,
    key: &str,
    stale: Option<ModelCatalogSnapshot>,
) -> Result<ModelCatalogSnapshot, AppError> {
    let models_dev = load_models_dev_fallback(db).unwrap_or_default();
    let user_agent = crate::provider::parse_custom_user_agent(params.custom_user_agent.as_deref())
        .ok()
        .flatten();
    let vendor_result = crate::services::model_fetch::fetch_models(
        &params.base_url,
        &params.api_key,
        params.is_full_url,
        params.models_url_override.as_deref(),
        user_agent,
        params.api_format.as_deref(),
        params.request_headers.as_ref(),
    )
    .await;
    let snapshot = build_snapshot(key, now_secs(), models_dev, vendor_result, stale);
    put_cached_catalog(snapshot.clone())?;
    Ok(snapshot)
}

async fn wait_for_refresh(
    key: &str,
    timeout: Duration,
) -> Result<Option<ModelCatalogSnapshot>, AppError> {
    let finished = tokio::time::timeout(timeout, async {
        loop {
            if !refreshing(key) {
                return get_cached_catalog(key);
            }
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
    })
    .await
    .map_err(|_| AppError::Config("等待现有模型目录刷新超时".to_string()))?;
    finished
}

async fn fetch_or_wait(
    db: std::sync::Arc<crate::database::Database>,
    params: FetchCatalogParams,
    key: String,
    stale: Option<ModelCatalogSnapshot>,
) -> Result<ModelCatalogSnapshot, AppError> {
    if let Some(_lease) = RefreshLease::claim(&key) {
        if let Some(current) = get_cached_catalog(&key)? {
            if snapshot_changed_since(stale.as_ref(), &current) {
                return Ok(current);
            }
        }
        refresh_catalog(&db, &params, &key, stale).await
    } else if let Some(snapshot) = wait_for_refresh(&key, Duration::from_secs(30)).await? {
        Ok(snapshot)
    } else {
        Err(AppError::Config(
            "模型目录刷新尚未完成，请稍后重试".to_string(),
        ))
    }
}

pub async fn fetch_catalog_for_provider(
    db: std::sync::Arc<crate::database::Database>,
    params: FetchCatalogParams,
    force_refresh: bool,
) -> Result<ModelCatalogSnapshot, AppError> {
    let key = provider_key(&params);
    let cached = get_cached_catalog(&key)?;
    if !force_refresh {
        if let Some(mut cached) = cached {
            if refreshing(&key) {
                cached.refreshing = true;
                return Ok(cached);
            }
            let now = now_secs();
            if !is_expired(&cached) {
                return Ok(cached);
            }
            if cache_is_in_retry_backoff(&cached, now) {
                if cached.vendor_error.is_none()
                    && cached.last_attempt_at_secs > cached.fetched_at_secs
                {
                    cached.vendor_error =
                        Some("The previous model catalog refresh did not complete".into());
                    let _ = put_cached_catalog(cached.clone());
                }
                return Ok(cached);
            }
            if let Some(lease) = RefreshLease::claim(&key) {
                let now = now_secs();
                cached.last_attempt_at_secs = now;
                cached.refreshing = true;
                // Publish the attempt time before starting the task so a
                // second window cannot start a parallel refresh.
                if put_cached_catalog(cached.clone()).is_err() {
                    log::debug!("Could not record model catalog refresh start");
                    cached.refreshing = false;
                    cached.vendor_error = Some("Could not update model catalog cache".into());
                    return Ok(cached);
                }
                let mut response = cached.clone();
                response.refreshing = true;
                let task_key = key.clone();
                let task_params = params.clone();
                tokio::spawn(async move {
                    let _lease = lease;
                    if refresh_catalog(&db, &task_params, &task_key, Some(cached))
                        .await
                        .is_err()
                    {
                        log::debug!("Background model catalog refresh could not update the cache");
                    }
                });
                return Ok(response);
            }
            cached.refreshing = true;
            return Ok(cached);
        }
    }

    // Initial fetches and explicit refreshes share one upstream request.
    fetch_or_wait(db, params, key, cached).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cache_params() -> FetchCatalogParams {
        FetchCatalogParams {
            base_url: "https://private-gateway.example/v1?access_token=private-url-token".into(),
            api_key: "private-api-key".into(),
            is_full_url: false,
            models_url_override: Some(
                "https://private-gateway.example/private/models?key=private-endpoint-token".into(),
            ),
            custom_user_agent: Some("private-user-agent".into()),
            api_format: Some("openai".into()),
            request_headers: Some(BTreeMap::from([(
                "X-Private-Route".into(),
                "private-header-value".into(),
            )])),
        }
    }

    #[test]
    fn catalog_cache_key_tracks_request_identity_without_persisting_secrets() {
        let params = cache_params();
        let key = provider_key(&params);
        assert_eq!(key.len(), 67);
        for secret in [
            "private-gateway",
            "private-url-token",
            "private-api-key",
            "private-endpoint-token",
            "private-user-agent",
            "private-header-value",
        ] {
            assert!(!key.contains(secret));
        }

        let mut changed = params.clone();
        changed.models_url_override = Some("https://private-gateway.example/other/models".into());
        assert_ne!(key, provider_key(&changed));
        changed = params.clone();
        changed.api_key.push_str("-rotated");
        assert_ne!(key, provider_key(&changed));
        changed = params.clone();
        changed.is_full_url = true;
        assert_ne!(key, provider_key(&changed));
        changed = params.clone();
        changed
            .request_headers
            .as_mut()
            .unwrap()
            .insert("X-Private-Route".into(), "another-route".into());
        assert_ne!(key, provider_key(&changed));
    }

    #[test]
    fn failed_refresh_retains_successful_models_and_retries_after_backoff() {
        let stale = ModelCatalogSnapshot {
            version: MODEL_CATALOG_VERSION,
            fetched_at_secs: 10,
            provider_key: "synthetic-cache-hash".into(),
            models: vec![CatalogModel {
                id: "private-account/model".into(),
                display_name: "Private model".into(),
                source: CatalogSource::Vendor,
                owned_by: Some("private-account".into()),
            }],
            vendor_error: None,
            last_attempt_at_secs: 10,
            refreshing: false,
        };
        let fallback = CatalogModel {
            id: "generic-fallback".into(),
            display_name: "Generic fallback".into(),
            source: CatalogSource::ModelsDev,
            owned_by: None,
        };
        let failed = build_snapshot(
            "synthetic-cache-hash",
            20,
            vec![fallback],
            Err("synthetic offline".into()),
            Some(stale.clone()),
        );
        assert_eq!(failed.models, stale.models);
        assert_eq!(failed.fetched_at_secs, stale.fetched_at_secs);
        assert_eq!(failed.last_attempt_at_secs, 20);
        assert_eq!(failed.vendor_error.as_deref(), Some("synthetic offline"));
        assert!(is_expired(&failed));
        assert!(cache_is_in_retry_backoff(
            &failed,
            20 + MODEL_CATALOG_RETRY_SECS - 1
        ));
        assert!(!cache_is_in_retry_backoff(
            &failed,
            20 + MODEL_CATALOG_RETRY_SECS
        ));
    }

    #[test]
    fn interrupted_refresh_uses_bounded_retry_backoff() {
        let stale = ModelCatalogSnapshot {
            version: MODEL_CATALOG_VERSION,
            fetched_at_secs: 10,
            provider_key: "synthetic-cache-hash".into(),
            models: Vec::new(),
            vendor_error: None,
            last_attempt_at_secs: 20,
            refreshing: false,
        };

        assert!(cache_is_in_retry_backoff(&stale, 20));
        assert!(cache_is_in_retry_backoff(
            &stale,
            20 + MODEL_CATALOG_RETRY_SECS - 1
        ));
        assert!(!cache_is_in_retry_backoff(
            &stale,
            20 + MODEL_CATALOG_RETRY_SECS
        ));
    }

    #[test]
    fn a_newer_snapshot_wins_when_another_initial_fetch_finished_first() {
        let previous = ModelCatalogSnapshot {
            version: MODEL_CATALOG_VERSION,
            fetched_at_secs: 10,
            provider_key: "synthetic-cache-hash".into(),
            models: Vec::new(),
            vendor_error: None,
            last_attempt_at_secs: 10,
            refreshing: false,
        };
        let mut current = previous.clone();
        current.fetched_at_secs = 11;
        current.last_attempt_at_secs = 11;

        assert!(snapshot_changed_since(None, &current));
        assert!(snapshot_changed_since(Some(&previous), &current));
        assert!(!snapshot_changed_since(Some(&previous), &previous));
    }

    #[test]
    fn initial_failure_keeps_fallback_models() {
        let fallback = CatalogModel {
            id: "known-model".into(),
            display_name: "Known model".into(),
            source: CatalogSource::ModelsDev,
            owned_by: None,
        };
        let failed = build_snapshot(
            "synthetic-cache-hash",
            20,
            vec![fallback.clone()],
            Err("synthetic offline".into()),
            None,
        );
        assert_eq!(failed.models, vec![fallback]);
        assert_eq!(failed.vendor_error.as_deref(), Some("synthetic offline"));
    }

    #[test]
    fn model_catalog_cache_prunes_expired_and_caps_endpoint_history() {
        let make_snapshot = |key: String, fetched_at_secs: u64| ModelCatalogSnapshot {
            version: MODEL_CATALOG_VERSION,
            fetched_at_secs,
            provider_key: key,
            models: Vec::new(),
            vendor_error: None,
            last_attempt_at_secs: fetched_at_secs,
            refreshing: false,
        };
        let now = 10_000_000;
        let mut snapshots = HashMap::from([(
            "expired".to_string(),
            make_snapshot("expired".into(), now - MODEL_CATALOG_RETENTION_SECS),
        )]);
        for index in 0..MODEL_CATALOG_MAX_SNAPSHOTS + 4 {
            snapshots.insert(
                format!("endpoint-{index:03}"),
                make_snapshot(format!("endpoint-{index:03}"), now + index as u64),
            );
        }
        prune_snapshots(&mut snapshots, now + 10_000);
        assert_eq!(snapshots.len(), MODEL_CATALOG_MAX_SNAPSHOTS);
        assert!(!snapshots.contains_key("expired"));
        assert!(snapshots.contains_key("endpoint-259"));
        assert!(!snapshots.contains_key("endpoint-000"));
    }

    #[test]
    fn snapshots_do_not_persist_refresh_state_or_unhashed_provider_identity() {
        let snapshot = ModelCatalogSnapshot {
            version: MODEL_CATALOG_VERSION,
            fetched_at_secs: 10,
            provider_key: provider_key(&cache_params()),
            models: Vec::new(),
            vendor_error: None,
            last_attempt_at_secs: 11,
            refreshing: true,
        };
        let disk = {
            let mut disk = snapshot.clone();
            disk.refreshing = false;
            serde_json::to_string(&disk).unwrap()
        };
        let ipc = serde_json::to_string(&snapshot).unwrap();
        assert!(!disk.contains("refreshing"));
        assert!(ipc.contains(r#""refreshing":true"#));
        for secret in [
            "private-gateway",
            "private-url-token",
            "private-api-key",
            "private-endpoint-token",
            "private-user-agent",
            "private-header-value",
        ] {
            assert!(!disk.contains(secret));
            assert!(!ipc.contains(secret));
        }
    }

    #[tokio::test]
    async fn refresh_lease_is_single_flight_and_releases_on_drop() {
        let key = "synthetic-single-flight";
        let first = RefreshLease::claim(key).expect("first caller claims refresh");
        assert!(refreshing(key));
        assert!(RefreshLease::claim(key).is_none());
        drop(first);
        assert!(!refreshing(key));
        assert!(RefreshLease::claim(key).is_some());
    }

    #[test]
    fn merge_prefers_vendor_and_marks_both() {
        let vendor = vec![FetchedModel {
            id: "gpt-4o".to_string(),
            owned_by: Some("openai".to_string()),
        }];
        let dev = vec![CatalogModel {
            id: "gpt-4o".to_string(),
            display_name: "GPT-4o".to_string(),
            source: CatalogSource::ModelsDev,
            owned_by: None,
        }];
        let merged = merge_catalog_models(vendor, dev);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].source, CatalogSource::Both);
        assert_eq!(merged[0].owned_by.as_deref(), Some("openai"));
    }

    #[test]
    fn merge_supplements_missing_models() {
        let vendor = vec![FetchedModel {
            id: "a".to_string(),
            owned_by: None,
        }];
        let dev = vec![
            CatalogModel {
                id: "a".to_string(),
                display_name: "A".to_string(),
                source: CatalogSource::ModelsDev,
                owned_by: None,
            },
            CatalogModel {
                id: "b".to_string(),
                display_name: "B".to_string(),
                source: CatalogSource::ModelsDev,
                owned_by: None,
            },
        ];
        let merged = merge_catalog_models(vendor, dev);
        assert_eq!(merged.len(), 2);
        assert!(merged
            .iter()
            .any(|m| m.id == "b" && m.source == CatalogSource::ModelsDev));
    }

    #[test]
    fn merge_result_is_sorted() {
        let vendor = vec![
            FetchedModel {
                id: "z".to_string(),
                owned_by: None,
            },
            FetchedModel {
                id: "a".to_string(),
                owned_by: None,
            },
        ];
        let merged = merge_catalog_models(vendor, vec![]);
        assert_eq!(merged[0].id, "a");
        assert_eq!(merged[1].id, "z");
    }
}
