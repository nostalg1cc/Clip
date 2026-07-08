use rusqlite::{params, Connection, Row};
use std::path::PathBuf;
use std::sync::Mutex;

const MAX_TEXT_CLIPS: usize = 500;
const MAX_IMAGE_CLIPS: usize = 30;
pub const DEFAULT_PURGE_HOURS: u32 = 24;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS clips (
    id           TEXT PRIMARY KEY,
    text         TEXT NOT NULL DEFAULT '',
    process      TEXT NOT NULL DEFAULT '',
    process_icon TEXT,
    timestamp    INTEGER NOT NULL,
    char_count   INTEGER NOT NULL DEFAULT 0,
    image_data   TEXT,
    pinned       INTEGER NOT NULL DEFAULT 0,
    img_w        INTEGER NOT NULL DEFAULT 0,
    img_h        INTEGER NOT NULL DEFAULT 0,
    name         TEXT,
    files        TEXT
);
CREATE INDEX IF NOT EXISTS idx_clips_ts ON clips(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_clips_pinned ON clips(pinned);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
";

/// One clipboard entry. Field names are the JSON contract with the frontend —
/// do not rename without updating App.tsx.
#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct ClipboardEntry {
    pub id: String,
    pub text: String,
    pub process: String,
    pub process_icon: Option<String>,
    pub timestamp: u64,
    pub char_count: usize,
    pub image_data: Option<String>,
    pub pinned: bool,
    #[serde(default)]
    pub img_w: u32,
    #[serde(default)]
    pub img_h: u32,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub files: Option<Vec<String>>,
}

fn row_to_entry(row: &Row) -> rusqlite::Result<ClipboardEntry> {
    let files_json: Option<String> = row.get(11)?;
    Ok(ClipboardEntry {
        id: row.get(0)?,
        text: row.get(1)?,
        process: row.get(2)?,
        process_icon: row.get(3)?,
        timestamp: row.get::<_, i64>(4)? as u64,
        char_count: row.get::<_, i64>(5)? as usize,
        image_data: row.get(6)?,
        pinned: row.get::<_, i64>(7)? != 0,
        img_w: row.get::<_, i64>(8)? as u32,
        img_h: row.get::<_, i64>(9)? as u32,
        name: row.get(10)?,
        files: files_json.and_then(|s| serde_json::from_str(&s).ok()),
    })
}

const COLS: &str =
    "id,text,process,process_icon,timestamp,char_count,image_data,pinned,img_w,img_h,name,files";

/// SQLite-backed clip store. Connection is serialized behind a Mutex; WAL keeps
/// writes append-style (no full-file rewrites).
pub struct Store {
    conn: Mutex<Connection>,
    pub data_dir: PathBuf,
}

impl Store {
    pub fn new(data_dir: PathBuf) -> Self {
        std::fs::create_dir_all(&data_dir).ok();
        let conn = Connection::open(data_dir.join("clips.db")).expect("open clips.db");
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")
            .ok();
        conn.execute_batch(SCHEMA).expect("init schema");
        let store = Self {
            conn: Mutex::new(conn),
            data_dir,
        };
        store.migrate_from_json();
        store.prune_expired();
        store
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn image_path(&self, id: &str) -> PathBuf {
        self.data_dir.join("images").join(format!("{id}.png"))
    }

    pub fn remove_image_file(&self, id: &str) {
        let _ = std::fs::remove_file(self.image_path(id));
    }

    /// Remove a downloaded media file (downloads/{id}.*), if any. No-op for
    /// non-download clips.
    pub fn remove_download_file(&self, id: &str) {
        let dir = self.data_dir.join("downloads");
        let prefix = format!("{id}.");
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if entry.file_name().to_string_lossy().starts_with(&prefix) {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }

    /// One-time import of the legacy clips.json, then archive it.
    fn migrate_from_json(&self) {
        let json_path = self.data_dir.join("clips.json");
        if !json_path.exists() {
            return;
        }
        let count: i64 = self
            .lock()
            .query_row("SELECT COUNT(*) FROM clips", [], |r| r.get(0))
            .unwrap_or(0);
        if count == 0 {
            if let Ok(s) = std::fs::read_to_string(&json_path) {
                if let Ok(entries) = serde_json::from_str::<Vec<ClipboardEntry>>(&s) {
                    for e in &entries {
                        self.add_clip(e);
                    }
                }
            }
        }
        let _ = std::fs::rename(&json_path, self.data_dir.join("clips.json.bak"));
    }

    pub fn add_clip(&self, e: &ClipboardEntry) {
        let conn = self.lock();
        let files = e.files.as_ref().and_then(|f| serde_json::to_string(f).ok());
        let _ = conn.execute(
            "INSERT OR REPLACE INTO clips (id,text,process,process_icon,timestamp,char_count,image_data,pinned,img_w,img_h,name,files) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            params![
                &e.id, &e.text, &e.process, &e.process_icon, e.timestamp as i64, e.char_count as i64,
                &e.image_data, e.pinned as i64, e.img_w as i64, e.img_h as i64, &e.name, files
            ],
        );

        // Enforce per-type caps on non-pinned clips, deleting the oldest overflow.
        let is_image = e.image_data.is_some();
        let (pred, cap) = if is_image {
            ("image_data IS NOT NULL", MAX_IMAGE_CLIPS)
        } else {
            ("image_data IS NULL", MAX_TEXT_CLIPS)
        };
        let sql = format!(
            "SELECT id FROM clips WHERE pinned=0 AND {pred} ORDER BY timestamp DESC, rowid DESC LIMIT -1 OFFSET {cap}"
        );
        let overflow: Vec<String> = match conn.prepare(&sql) {
            Ok(mut stmt) => stmt
                .query_map([], |r| r.get::<_, String>(0))
                .map(|rs| rs.filter_map(|x| x.ok()).collect())
                .unwrap_or_default(),
            Err(_) => Vec::new(),
        };
        for id in &overflow {
            self.remove_image_file(id);
            self.remove_download_file(id);
            let _ = conn.execute("DELETE FROM clips WHERE id=?1", params![id]);
        }
    }

    pub fn toggle_pin(&self, id: &str) -> bool {
        let conn = self.lock();
        let _ = conn.execute(
            "UPDATE clips SET pinned = 1 - pinned WHERE id = ?1",
            params![id],
        );
        conn.query_row("SELECT pinned FROM clips WHERE id = ?1", params![id], |r| {
            r.get::<_, i64>(0)
        })
        .map(|v| v != 0)
        .unwrap_or(false)
    }

    pub fn delete_clip(&self, id: &str) {
        self.remove_image_file(id);
        self.remove_download_file(id);
        let _ = self
            .lock()
            .execute("DELETE FROM clips WHERE id = ?1", params![id]);
    }

    pub fn rename(&self, id: &str, name: Option<String>) {
        let _ = self.lock().execute(
            "UPDATE clips SET name = ?2 WHERE id = ?1",
            params![id, name],
        );
    }

    pub fn clear_all(&self) {
        let conn = self.lock();
        // All unpinned ids, so we can remove any backing image/download files.
        let ids: Vec<String> = match conn.prepare("SELECT id FROM clips WHERE pinned=0") {
            Ok(mut stmt) => stmt
                .query_map([], |r| r.get::<_, String>(0))
                .map(|rs| rs.filter_map(|x| x.ok()).collect())
                .unwrap_or_default(),
            Err(_) => Vec::new(),
        };
        for id in &ids {
            self.remove_image_file(id);
            self.remove_download_file(id);
        }
        let _ = conn.execute("DELETE FROM clips WHERE pinned=0", []);
    }

    pub fn purge_hours(&self) -> u32 {
        self.get_setting("purge_hours")
            .and_then(|v| v.parse::<u32>().ok())
            .filter(|h| (1..=720).contains(h))
            .unwrap_or(DEFAULT_PURGE_HOURS)
    }

    /// Delete unpinned clips older than the TTL. Returns true if anything changed.
    pub fn prune_expired(&self) -> bool {
        let ttl_ms = self.purge_hours() as u64 * 60 * 60 * 1000;
        let cutoff = super::now_millis().saturating_sub(ttl_ms) as i64;
        let conn = self.lock();
        let ids: Vec<String> =
            match conn.prepare("SELECT id FROM clips WHERE pinned=0 AND timestamp < ?1") {
                Ok(mut stmt) => stmt
                    .query_map(params![cutoff], |r| r.get::<_, String>(0))
                    .map(|rs| rs.filter_map(|x| x.ok()).collect())
                    .unwrap_or_default(),
                Err(_) => Vec::new(),
            };
        for id in &ids {
            self.remove_image_file(id);
            self.remove_download_file(id);
        }
        let n = conn
            .execute(
                "DELETE FROM clips WHERE pinned=0 AND timestamp < ?1",
                params![cutoff],
            )
            .unwrap_or(0);
        n > 0
    }

    pub fn get_all(&self) -> Vec<ClipboardEntry> {
        let conn = self.lock();
        let sql = format!("SELECT {COLS} FROM clips ORDER BY timestamp DESC, rowid DESC");
        let mut stmt = match conn.prepare(&sql) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map([], row_to_entry);
        match rows {
            Ok(rs) => rs.filter_map(|x| x.ok()).collect(),
            Err(_) => Vec::new(),
        }
    }

    pub fn find(&self, id: &str) -> Option<ClipboardEntry> {
        let conn = self.lock();
        let sql = format!("SELECT {COLS} FROM clips WHERE id = ?1");
        conn.query_row(&sql, params![id], row_to_entry).ok()
    }

    // ── Settings (key/value) ──
    pub fn get_setting(&self, key: &str) -> Option<String> {
        self.lock()
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![key],
                |r| r.get(0),
            )
            .ok()
    }

    pub fn set_setting(&self, key: &str, value: &str) {
        let _ = self.lock().execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
            params![key, value],
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn tmp_store() -> Store {
        static N: AtomicU32 = AtomicU32::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "clip-test-{}-{}-{}",
            std::process::id(),
            super::super::now_millis(),
            n
        ));
        let _ = std::fs::remove_dir_all(&dir);
        Store::new(dir)
    }

    /// Add a "download"-style clip: a real file in downloads/{id}.mp4 plus a row
    /// with an embedded thumbnail. `age_ms` is how far in the past to timestamp it.
    fn add_download(store: &Store, id: &str, age_ms: u64) -> PathBuf {
        let dl = store.data_dir.join("downloads");
        std::fs::create_dir_all(&dl).unwrap();
        let file = dl.join(format!("{id}.mp4"));
        std::fs::write(&file, b"fake video bytes").unwrap();
        let entry = ClipboardEntry {
            id: id.to_string(),
            text: "clip".into(),
            process: "Downloader".into(),
            process_icon: None,
            timestamp: super::super::now_millis().saturating_sub(age_ms),
            char_count: 16,
            image_data: Some("data:image/jpeg;base64,AAAA".into()),
            pinned: false,
            img_w: 0,
            img_h: 0,
            name: None,
            files: Some(vec![file.to_string_lossy().to_string()]),
        };
        store.add_clip(&entry);
        file
    }

    const DAY: u64 = 24 * 60 * 60 * 1000;

    #[test]
    fn prune_wipes_unpinned_download_entry_and_file() {
        let store = tmp_store();
        let file = add_download(&store, "old1", DAY + 60_000); // >24h old
        assert!(file.exists(), "file should exist before prune");

        assert!(store.prune_expired(), "prune should report a change");

        assert!(store.find("old1").is_none(), "entry should be gone");
        assert!(
            !file.exists(),
            "downloaded file should be deleted from disk"
        );
    }

    #[test]
    fn prune_keeps_pinned_download() {
        let store = tmp_store();
        let file = add_download(&store, "keep1", DAY + 60_000);
        store.toggle_pin("keep1"); // pin it

        store.prune_expired();

        assert!(store.find("keep1").is_some(), "pinned entry should survive");
        assert!(file.exists(), "pinned file should survive on disk");
    }

    #[test]
    fn clear_all_wipes_unpinned_file_but_keeps_pinned() {
        let store = tmp_store();
        let gone = add_download(&store, "a", 1000);
        let kept = add_download(&store, "b", 1000);
        store.toggle_pin("b");

        store.clear_all();

        assert!(
            store.find("a").is_none() && !gone.exists(),
            "unpinned wiped"
        );
        assert!(store.find("b").is_some() && kept.exists(), "pinned kept");
    }

    #[test]
    fn size_cap_eviction_removes_download_file() {
        let store = tmp_store();
        // Oldest first so it becomes the overflow victim once we exceed the cap.
        let victim = add_download(&store, "v", 10_000);
        for i in 0..(MAX_IMAGE_CLIPS as u32) {
            add_download(&store, &format!("f{i}"), 5_000 - i as u64);
        }
        assert!(
            store.find("v").is_none(),
            "oldest entry should be evicted by the cap"
        );
        assert!(
            !victim.exists(),
            "evicted download file should be deleted from disk"
        );
    }
}
