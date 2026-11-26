//! Shared channels retain the existing universal_providers storage format.

use crate::database::{lock_conn, to_json_string, Database};
use crate::error::AppError;
use crate::provider::{Provider, UniversalProvider};
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashMap;

const UNIVERSAL_PROVIDERS_KEY: &str = "universal_providers";

fn read_channels(conn: &Connection) -> Result<HashMap<String, UniversalProvider>, AppError> {
    let json: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?",
            [UNIVERSAL_PROVIDERS_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| AppError::Database(error.to_string()))?;
    json.map(|json| {
        serde_json::from_str(&json)
            .map_err(|_| AppError::Database("Invalid shared channel data".to_string()))
    })
    .unwrap_or_else(|| Ok(HashMap::new()))
}

fn write_channels(
    conn: &Connection,
    channels: &HashMap<String, UniversalProvider>,
) -> Result<(), AppError> {
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
        [UNIVERSAL_PROVIDERS_KEY, &to_json_string(channels)?],
    )
    .map_err(|error| AppError::Database(error.to_string()))?;
    Ok(())
}

pub(crate) fn shared_channel_in_use() -> AppError {
    AppError::localized(
        "shared_channel.in_use",
        "共享渠道仍在使用中。请先切换当前供应商，并从路由分组、备用队列和模型别名中移除关联，再停用或删除。",
        "This shared channel is still in use. Switch the current provider and remove its routing group, failover queue and model alias references before disabling or deleting it.",
    )
}

fn remove_child(conn: &Connection, app: &str, id: &str) -> Result<(), AppError> {
    let referenced: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM providers WHERE id = ?1 AND app_type = ?2 AND (is_current = 1 OR in_failover_queue = 1))
         OR EXISTS(SELECT 1 FROM routing_group_members WHERE provider_id = ?1 AND app_type = ?2)
         OR EXISTS(SELECT 1 FROM model_aliases WHERE provider_id = ?1 AND app_type = ?2)",
        params![id, app], |row| row.get(0),
    ).map_err(|error| AppError::Database(error.to_string()))?;
    if referenced {
        return Err(shared_channel_in_use());
    }
    conn.execute(
        "DELETE FROM providers WHERE id = ?1 AND app_type = ?2",
        params![id, app],
    )
    .map_err(|error| AppError::Database(error.to_string()))?;
    conn.execute(
        "DELETE FROM stream_check_logs WHERE provider_id = ?1 AND app_type = ?2",
        params![id, app],
    )
    .map_err(|error| AppError::Database(error.to_string()))?;
    Ok(())
}

/// Imported rows retain their identity, current selection and references.
fn release_child(
    tx: &rusqlite::Transaction<'_>,
    channel: &UniversalProvider,
    app: &str,
) -> Result<(), AppError> {
    let id = channel.child_id(app);
    if channel.has_adopted_child(app) {
        if let Some(mut child) = Database::get_provider_in_connection(tx, &id, app)? {
            if child
                .meta
                .as_ref()
                .and_then(|meta| meta.shared_channel_id.as_deref())
                != Some(&channel.id)
            {
                return Err(AppError::Message("Invalid shared channel binding".into()));
            }
            child
                .meta
                .get_or_insert_with(Default::default)
                .shared_channel_id = None;
            Database::save_provider_in_transaction(tx, app, &child)?;
        }
        Ok(())
    } else {
        let enabled = match app {
            "claude" => channel.apps.claude,
            "codex" => channel.apps.codex,
            "gemini" => channel.apps.gemini,
            _ => false,
        };
        if !enabled {
            return Ok(());
        }
        if Database::get_provider_in_connection(tx, &id, app)?.is_some_and(|child| {
            child
                .meta
                .as_ref()
                .and_then(|meta| meta.shared_channel_id.as_deref())
                .is_some_and(|owner| owner != channel.id)
        }) {
            return Err(AppError::Message("Invalid shared channel binding".into()));
        }
        remove_child(tx, app, &id)
    }
}

impl Database {
    pub fn get_all_universal_providers(
        &self,
    ) -> Result<HashMap<String, UniversalProvider>, AppError> {
        let conn = lock_conn!(self.conn);
        read_channels(&conn)
    }

    pub fn get_universal_provider(&self, id: &str) -> Result<Option<UniversalProvider>, AppError> {
        Ok(self.get_all_universal_providers()?.remove(id))
    }

    pub fn save_universal_provider(&self, provider: &UniversalProvider) -> Result<(), AppError> {
        let conn = lock_conn!(self.conn);
        let mut channels = read_channels(&conn)?;
        channels.insert(provider.id.clone(), provider.clone());
        write_channels(&conn, &channels)
    }

    pub fn delete_universal_provider(&self, id: &str) -> Result<bool, AppError> {
        let conn = lock_conn!(self.conn);
        let mut channels = read_channels(&conn)?;
        let existed = channels.remove(id).is_some();
        write_channels(&conn, &channels)?;
        Ok(existed)
    }

    /// Commit the master and every child together. A rejected removal or write
    /// leaves the existing master, credentials and children unchanged.
    pub(crate) fn save_shared_channel_children(
        &self,
        provider: &UniversalProvider,
        children: &[(String, Provider)],
        removed_apps: &[String],
    ) -> Result<(), AppError> {
        let mut conn = lock_conn!(self.conn);
        let tx = conn
            .transaction()
            .map_err(|error| AppError::Database(error.to_string()))?;
        let mut channels = read_channels(&tx)?;
        if let Some(previous) = channels.get(&provider.id) {
            for app in removed_apps {
                release_child(&tx, previous, app)?;
            }
        }
        channels.insert(provider.id.clone(), provider.clone());
        write_channels(&tx, &channels)?;
        for (app, child) in children {
            Self::save_provider_in_transaction(&tx, app, child)?;
        }
        tx.commit()
            .map_err(|error| AppError::Database(error.to_string()))
    }

    /// Compare both source rows in the same transaction as the relationship write.
    pub(crate) fn link_shared_channel_children(
        &self,
        channel: &UniversalProvider,
        original: &[(String, Provider)],
        children: &[(String, Provider)],
    ) -> Result<(), AppError> {
        let mut conn = lock_conn!(self.conn);
        let tx = conn.transaction()?;
        let mut channels = read_channels(&tx)?;
        let conflict = || {
            AppError::localized(
                "shared_channel.link_stale",
                "配置已变化，请重新预览后关联。",
                "Configuration changed. Preview the link again.",
            )
        };
        if channels.contains_key(&channel.id) {
            return Err(conflict());
        }
        for (app, provider) in original {
            let current =
                Self::get_provider_in_connection(&tx, &provider.id, app)?.ok_or_else(conflict)?;
            if serde_json::to_value(&current).ok() != serde_json::to_value(provider).ok()
                || channels
                    .values()
                    .any(|existing| existing.child_id(app) == provider.id)
            {
                return Err(conflict());
            }
        }
        channels.insert(channel.id.clone(), channel.clone());
        write_channels(&tx, &channels)?;
        for (app, child) in children {
            Self::save_provider_in_transaction(&tx, app, child)?;
        }
        tx.commit()?;
        Ok(())
    }

    pub(crate) fn delete_shared_channel_children(&self, id: &str) -> Result<bool, AppError> {
        let mut conn = lock_conn!(self.conn);
        let tx = conn
            .transaction()
            .map_err(|error| AppError::Database(error.to_string()))?;
        let mut channels = read_channels(&tx)?;
        if let Some(channel) = channels.get(id) {
            for app in ["claude", "codex", "gemini"] {
                release_child(&tx, channel, app)?;
            }
        }
        let existed = channels.remove(id).is_some();
        write_channels(&tx, &channels)?;
        tx.commit()
            .map_err(|error| AppError::Database(error.to_string()))?;
        Ok(existed)
    }
}
