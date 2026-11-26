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
        for app in removed_apps {
            remove_child(&tx, app, &format!("universal-{app}-{}", provider.id))?;
        }
        let mut channels = read_channels(&tx)?;
        channels.insert(provider.id.clone(), provider.clone());
        write_channels(&tx, &channels)?;
        for (app, child) in children {
            Self::save_provider_in_transaction(&tx, app, child)?;
        }
        tx.commit()
            .map_err(|error| AppError::Database(error.to_string()))
    }

    pub(crate) fn delete_shared_channel_children(&self, id: &str) -> Result<bool, AppError> {
        let mut conn = lock_conn!(self.conn);
        let tx = conn
            .transaction()
            .map_err(|error| AppError::Database(error.to_string()))?;
        for app in ["claude", "codex", "gemini"] {
            remove_child(&tx, app, &format!("universal-{app}-{id}"))?;
        }
        let mut channels = read_channels(&tx)?;
        let existed = channels.remove(id).is_some();
        write_channels(&tx, &channels)?;
        tx.commit()
            .map_err(|error| AppError::Database(error.to_string()))?;
        Ok(existed)
    }
}
