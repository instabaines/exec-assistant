use lettre::{
    message::{header::ContentType, Mailbox},
    transport::smtp::authentication::Credentials,
    Message, SmtpTransport, Transport,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    env, fs,
    path::PathBuf,
    process::Command,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};
use tauri_plugin_shell::ShellExt;

// ── Ollama sidecar process state ──────────────────────────────────────────────

type OllamaProcess = std::sync::Arc<std::sync::Mutex<Option<tauri_plugin_shell::process::CommandChild>>>;

#[derive(Serialize, Clone)]
struct OllamaStatus {
    running: bool,
    source: String, // "external" | "sidecar" | "none"
    models: Vec<String>,
}

fn fetch_ollama_models() -> Vec<String> {
    match ureq::get("http://localhost:11434/api/tags").call() {
        Ok(resp) => resp
            .into_json::<serde_json::Value>()
            .ok()
            .and_then(|j| j["models"].as_array().cloned())
            .unwrap_or_default()
            .iter()
            .filter_map(|m| m["name"].as_str().map(String::from))
            .collect(),
        Err(_) => vec![],
    }
}

#[tauri::command]
fn ensure_ollama_running(app: tauri::AppHandle) -> Result<OllamaStatus, String> {
    // Already running externally or from a previous sidecar start?
    if let Ok(resp) = ureq::get("http://localhost:11434/api/tags").call() {
        if resp.status() == 200 {
            return Ok(OllamaStatus {
                running: true,
                source: "external".into(),
                models: fetch_ollama_models(),
            });
        }
    }

    // Try to start the bundled sidecar
    let sidecar_cmd = app.shell().sidecar("ollama").map_err(|e| {
        format!("Ollama not bundled with this build — install it from ollama.com. ({})", e)
    })?;

    let (rx, child) = sidecar_cmd
        .args(["serve"])
        .spawn()
        .map_err(|e| format!("Failed to start Ollama: {}", e))?;

    // Store the child so it lives as long as the app
    {
        let state = app.state::<OllamaProcess>();
        *state.lock().unwrap() = Some(child);
    }

    // Drain stdout/stderr in a background task so the channel never fills up
    tauri::async_runtime::spawn(async move {
        let mut rx = rx;
        while rx.recv().await.is_some() {}
    });

    // Wait up to 12 s for Ollama to be ready
    for _ in 0..24 {
        std::thread::sleep(std::time::Duration::from_millis(500));
        if let Ok(resp) = ureq::get("http://localhost:11434/api/tags").call() {
            if resp.status() == 200 {
                return Ok(OllamaStatus {
                    running: true,
                    source: "sidecar".into(),
                    models: fetch_ollama_models(),
                });
            }
        }
    }

    Err("Ollama started but is not responding. It may still be loading — try again in a moment.".into())
}

#[tauri::command]
fn pull_ollama_model(app: tauri::AppHandle, model: String) -> Result<(), String> {
    std::thread::spawn(move || {
        let body = serde_json::json!({ "name": model, "stream": true });
        match ureq::post("http://localhost:11434/api/pull").send_json(&body) {
            Ok(resp) => {
                use std::io::BufRead;
                let reader = std::io::BufReader::new(resp.into_reader());
                for line in reader.lines() {
                    let Ok(line) = line else { break };
                    if line.is_empty() {
                        continue;
                    }
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) {
                        app.emit("ollama-pull-progress", &val).ok();
                        if val["status"].as_str() == Some("success") {
                            break;
                        }
                    }
                }
                app.emit("ollama-pull-complete", &model).ok();
            }
            Err(e) => {
                app.emit("ollama-pull-error", e.to_string()).ok();
            }
        }
    });
    Ok(())
}

#[derive(Serialize)]
struct OllamaHealth {
    installed: bool,
    version: Option<String>,
    message: String,
}

#[derive(Serialize)]
struct StoreStatus {
    database_path: String,
    created: bool,
}

#[derive(Deserialize)]
struct ClientImportPayload {
    source_file_name: String,
    profile_name: String,
    mapping: ClientMapping,
    rows: Vec<HashMap<String, String>>,
}

#[derive(Deserialize, Serialize)]
struct ClientMapping {
    name: String,
    email: String,
    industry: String,
    company: String,
    last_contacted_at: String,
}

#[derive(Serialize)]
struct ImportResult {
    imported_count: usize,
    skipped_count: usize,
    profile_id: i64,
}

#[derive(Serialize)]
struct TemplateRecord {
    id: i64,
    name: String,
    industry: String,
    tone: String,
    subject_template: String,
    body_template: String,
    system_prompt: String,
    version: i64,
    active: bool,
}

#[derive(Deserialize)]
struct TemplateUpsertPayload {
    id: Option<i64>,
    name: String,
    industry: String,
    tone: String,
    subject_template: String,
    body_template: String,
    system_prompt: String,
    active: bool,
}

#[derive(Serialize)]
struct TemplateUpsertResult {
    id: i64,
    version: i64,
}

#[derive(Serialize)]
struct GenerationSettings {
    model: String,
    default_system_prompt: String,
    sender_name: String,
    sender_position: String,
    sender_company: String,
}

#[derive(Deserialize)]
struct GenerationSettingsPayload {
    model: String,
    default_system_prompt: String,
    sender_name: String,
    sender_position: String,
    sender_company: String,
}

#[derive(Deserialize)]
struct DraftGenerationPayload {
    model: Option<String>,
    template_id: Option<i64>,
    max_clients: Option<usize>,
    campaign_name: Option<String>,
    campaign_goal: Option<String>,
    call_to_action: Option<String>,
    extra_context: Option<String>,
    use_agent_pipeline: Option<bool>,
}

#[derive(Serialize)]
struct DraftGenerationResult {
    campaign_id: i64,
    generated_count: usize,
    flagged_count: usize,
    failed_count: usize,
}

#[derive(Serialize, Clone)]
struct GenerationJobStatus {
    id: i64,
    status: String,
    campaign_id: i64,
    total_count: usize,
    generated_count: usize,
    flagged_count: usize,
    failed_count: usize,
    current_client_name: Option<String>,
    error_message: Option<String>,
}

#[derive(Serialize, Clone)]
struct GenerationProgressEvent {
    job: GenerationJobStatus,
    draft: Option<DraftRecord>,
}

#[derive(Serialize, Clone)]
struct DraftRecord {
    id: i64,
    campaign_id: i64,
    campaign_name: String,
    client_id: i64,
    client_name: String,
    client_email: String,
    client_industry: String,
    client_company: String,
    subject: String,
    body: String,
    status: String,
    template_name: String,
    created_at: String,
    generation_mode: String,
    generation_label: String,
    needs_attention: bool,
}

#[derive(Deserialize)]
struct DraftUpdatePayload {
    draft_id: i64,
    subject: String,
    body: String,
    status: String,
}

#[derive(Deserialize)]
struct DraftRegeneratePayload {
    draft_id: i64,
    instruction: Option<String>,
    model: Option<String>,
}

#[derive(Deserialize)]
struct ExportDraftsPayload {
    campaign_id: Option<i64>,
    draft_ids: Vec<i64>,
    format: String,
    file_name: String,
}

#[derive(Deserialize)]
struct CampaignFilterPayload {
    campaign_id: Option<i64>,
}

#[derive(Deserialize)]
struct DeleteCampaignPayload {
    campaign_id: i64,
}

#[derive(Deserialize)]
struct DeleteDraftPayload {
    draft_id: i64,
}

#[derive(Deserialize)]
struct DeleteClientPayload {
    client_id: i64,
}

#[derive(Deserialize)]
struct ResetWorkspacePayload {
    clear_campaigns: bool,
    clear_clients: bool,
}

#[derive(Serialize)]
struct DeleteResult {
    deleted_count: usize,
}

#[derive(Serialize)]
struct CampaignRecord {
    id: i64,
    name: String,
    status: String,
    created_at: String,
    draft_count: i64,
}

#[derive(Serialize)]
struct ClientCount {
    total: i64,
}

#[derive(Deserialize)]
struct SingleClientPayload {
    name: String,
    email: String,
    company: Option<String>,
    industry: Option<String>,
}

#[derive(Deserialize)]
struct BulkApprovePayload {
    campaign_id: Option<i64>,
}

#[derive(Serialize)]
struct BulkApproveResult {
    approved_count: usize,
}

#[derive(Serialize)]
struct StoredClientRecord {
    id: i64,
    name: String,
    email: String,
    industry: String,
    company: String,
    last_contacted_at: String,
    updated_at: String,
}

#[derive(Serialize)]
struct WorkflowSummary {
    total_clients: i64,
    review_required: i64,
    approved: i64,
    sent: i64,
    exported: i64,
}

#[derive(Serialize)]
struct SendResult {
    sent_count: usize,
}

#[derive(Serialize)]
struct HistoryRecord {
    id: i64,
    draft_id: i64,
    client_name: String,
    client_email: String,
    event_type: String,
    detail: String,
    happened_at: String,
    status: String,
}

#[derive(Serialize)]
struct AvailableModels {
    models: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone)]
struct EmailSettings {
    smtp_host: String,
    smtp_port: u16,
    smtp_user: String,
    smtp_password: String,
    smtp_from_name: String,
    booking_url: String,
}

#[derive(Deserialize)]
struct EmailSettingsPayload {
    smtp_host: String,
    smtp_port: u16,
    smtp_user: String,
    smtp_password: String,
    smtp_from_name: String,
    booking_url: String,
}

#[derive(Serialize, Clone)]
struct SendProgressEvent {
    draft_id: Option<i64>,
    client_name: Option<String>,
    status: String,
    error: Option<String>,
    sent_count: usize,
    failed_count: usize,
    total_count: usize,
    done: bool,
}

#[derive(Deserialize)]
struct SendCampaignPayload {
    campaign_id: i64,
}

#[derive(Serialize)]
struct SendCampaignResult {
    sent_count: usize,
    failed_count: usize,
    approved_count: usize,
}

#[derive(Deserialize)]
struct ScheduleCampaignPayload {
    campaign_id: i64,
    scheduled_at: Option<String>,
}

#[derive(Serialize)]
struct CampaignSendStatus {
    campaign_id: i64,
    campaign_name: String,
    approved_count: i64,
    sent_count: i64,
    scheduled_at: Option<String>,
}

struct TemplateRow {
    id: i64,
    tone: String,
    subject_template: String,
    body_template: String,
    system_prompt: String,
}

struct ClientRow {
    id: i64,
    name: String,
    email: String,
    industry: String,
    company: String,
    last_contacted_at: String,
}

fn open_database(app: &tauri::AppHandle) -> Result<Connection, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&app_data_dir).map_err(|e| e.to_string())?;
    let database_path = app_data_dir.join("assistant.db");
    Connection::open(&database_path).map_err(|e| e.to_string())
}

fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS import_profiles (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          source_file_name TEXT,
          column_mapping_json TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS clients (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          email TEXT NOT NULL,
          industry TEXT NOT NULL,
          company TEXT,
          last_contacted_at TEXT,
          custom_fields_json TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS templates (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          industry TEXT NOT NULL,
          tone TEXT NOT NULL,
          subject_template TEXT NOT NULL,
          body_template TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS campaigns (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          filter_json TEXT NOT NULL,
          template_id INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'draft',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(template_id) REFERENCES templates(id)
        );

        CREATE TABLE IF NOT EXISTS drafts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          campaign_id INTEGER NOT NULL,
          client_id INTEGER NOT NULL,
          subject TEXT NOT NULL,
          body TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          generation_meta_json TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(campaign_id) REFERENCES campaigns(id),
          FOREIGN KEY(client_id) REFERENCES clients(id)
        );

        CREATE TABLE IF NOT EXISTS send_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          draft_id INTEGER NOT NULL,
          provider TEXT NOT NULL,
          provider_message_id TEXT,
          sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          delivery_status TEXT NOT NULL DEFAULT 'sent',
          FOREIGN KEY(draft_id) REFERENCES drafts(id)
        );

        CREATE TABLE IF NOT EXISTS export_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          draft_id INTEGER NOT NULL,
          format TEXT NOT NULL,
          file_name TEXT,
          exported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(draft_id) REFERENCES drafts(id)
        );

        CREATE TABLE IF NOT EXISTS settings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          key TEXT NOT NULL UNIQUE,
          value_json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS generation_jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          status TEXT NOT NULL DEFAULT 'pending',
          campaign_id INTEGER NOT NULL,
          total_count INTEGER NOT NULL DEFAULT 0,
          generated_count INTEGER NOT NULL DEFAULT 0,
          flagged_count INTEGER NOT NULL DEFAULT 0,
          failed_count INTEGER NOT NULL DEFAULT 0,
          current_client_name TEXT,
          error_message TEXT,
          started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          completed_at TEXT,
          FOREIGN KEY(campaign_id) REFERENCES campaigns(id)
        );

        CREATE TABLE IF NOT EXISTS tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          description TEXT,
          status TEXT NOT NULL DEFAULT 'todo',
          priority TEXT NOT NULL DEFAULT 'medium',
          due_date TEXT,
          source_type TEXT,
          source_id INTEGER,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS meetings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          meeting_date TEXT,
          attendees TEXT,
          raw_notes TEXT,
          summary TEXT,
          action_items_json TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS deals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          company TEXT,
          contact_name TEXT,
          contact_email TEXT,
          value_text TEXT,
          stage TEXT NOT NULL DEFAULT 'lead',
          notes TEXT,
          next_action TEXT,
          next_action_date TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS documents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          doc_type TEXT NOT NULL DEFAULT 'proposal',
          brief TEXT,
          content TEXT,
          status TEXT NOT NULL DEFAULT 'draft',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS knowledge_documents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          doc_type TEXT NOT NULL DEFAULT 'company',
          campaign_id INTEGER,
          contact_id INTEGER,
          content TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_knowledge_docs_type ON knowledge_documents(doc_type);

        CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_email ON clients(email);
        CREATE INDEX IF NOT EXISTS idx_templates_industry_active ON templates(industry, active);
        CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status);
        CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
        CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals(stage);
    ",
    )
    .map_err(|e| e.to_string())?;

    // Backward-compatible migrations.
    let _ = conn.execute(
        "ALTER TABLE templates ADD COLUMN system_prompt TEXT NOT NULL DEFAULT ''",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE clients ADD COLUMN company TEXT",
        [],
    );
    let _ = conn.execute("ALTER TABLE campaigns ADD COLUMN scheduled_at TEXT", []);
    let _ = conn.execute("ALTER TABLE drafts ADD COLUMN sent_at TEXT", []);
    let _ = conn.execute("ALTER TABLE clients ADD COLUMN notes TEXT", []);
    if !column_exists(conn, "generation_jobs", "updated_at")? {
        conn.execute("ALTER TABLE generation_jobs ADD COLUMN updated_at TEXT", [])
            .map_err(|e| e.to_string())?;
        conn.execute(
            "
            UPDATE generation_jobs
            SET updated_at = COALESCE(completed_at, started_at, CURRENT_TIMESTAMP)
            WHERE updated_at IS NULL
        ",
            [],
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(())
}

fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let pragma = format!("PRAGMA table_info({table})");
    let mut statement = conn.prepare(&pragma).map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<usize, String>(1))
        .map_err(|e| e.to_string())?;

    for row in rows {
        if row.map_err(|e| e.to_string())? == column {
            return Ok(true);
        }
    }

    Ok(false)
}

fn normalize_base_url(value: &str) -> String {
    let trimmed = value.trim().trim_end_matches('/').to_owned();
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed
    } else {
        format!("http://{trimmed}")
    }
}

fn ollama_base_url_candidates() -> Vec<String> {
    let mut candidates = Vec::new();

    if let Some(url) = env::var_os("OLLAMA_BASE_URL").and_then(|v| v.into_string().ok()) {
        candidates.push(normalize_base_url(&url));
    }

    if let Some(host) = env::var_os("OLLAMA_HOST").and_then(|v| v.into_string().ok()) {
        candidates.push(normalize_base_url(&host));
    }

    candidates.push("http://127.0.0.1:11434".to_owned());
    candidates.push("http://localhost:11434".to_owned());
    candidates.push("http://172.19.160.1:11434".to_owned());

    candidates.sort();
    candidates.dedup();
    candidates
}

fn find_ollama_binary() -> Option<PathBuf> {
    if let Some(custom) = env::var_os("OLLAMA_PATH").map(PathBuf::from) {
        if custom.exists() {
            return Some(custom);
        }
    }

    if let Some(path_var) = env::var_os("PATH") {
        for dir in env::split_paths(&path_var) {
            let candidate = dir.join("ollama");
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }

    let common_locations = [
        "/usr/local/bin/ollama",
        "/usr/bin/ollama",
        "/opt/homebrew/bin/ollama",
        "/opt/local/bin/ollama",
    ];
    for location in common_locations {
        let candidate = PathBuf::from(location);
        if candidate.exists() {
            return Some(candidate);
        }
    }

    None
}

fn check_ollama_http_health() -> Option<(String, Option<String>)> {
    let client = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(2))
        .timeout_read(Duration::from_secs(3))
        .build();

    for base_url in ollama_base_url_candidates() {
        let tags_url = format!("{base_url}/api/tags");
        if client.get(&tags_url).call().is_ok() {
            let version_url = format!("{base_url}/api/version");
            let version = client
                .get(&version_url)
                .call()
                .ok()
                .and_then(|resp| resp.into_json::<serde_json::Value>().ok())
                .and_then(|json| {
                    json.get("version")
                        .and_then(|v| v.as_str())
                        .map(|v| v.to_owned())
                });
            return Some((base_url, version));
        }
    }
    None
}

fn list_ollama_models_internal() -> Vec<String> {
    let client = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(2))
        .timeout_read(Duration::from_secs(4))
        .build();

    for base_url in ollama_base_url_candidates() {
        let tags_url = format!("{base_url}/api/tags");
        let response = client.get(&tags_url).call();
        if let Ok(resp) = response {
            if let Ok(json) = resp.into_json::<serde_json::Value>() {
                let mut models = Vec::new();
                if let Some(arr) = json.get("models").and_then(|v| v.as_array()) {
                    for item in arr {
                        if let Some(name) = item.get("name").and_then(|v| v.as_str()) {
                            models.push(name.to_owned());
                        }
                    }
                }
                models.sort();
                models.dedup();
                return models;
            }
        }
    }
    Vec::new()
}

fn resolve_generation_model(conn: &Connection) -> Result<String, String> {
    let configured_model = get_setting_value(conn, "generation_model")?;
    let available_models = list_ollama_models_internal();

    if let Some(model) = configured_model {
        if available_models.is_empty() || available_models.iter().any(|candidate| candidate == &model) {
            return Ok(model);
        }
    }

    available_models
        .into_iter()
        .next()
        .ok_or_else(|| "No Ollama models are currently available.".to_owned())
}

fn get_setting_value(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    let value: Option<String> = conn
        .query_row(
            "SELECT value_json FROM settings WHERE key = ?1 LIMIT 1",
            [key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(value)
}

fn set_setting_value(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "
        INSERT INTO settings (key, value_json)
        VALUES (?1, ?2)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
    ",
        params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn render_template_value(template: &str, client: &ClientRow, settings: &GenerationSettings) -> String {
    template
        .replace("{{name}}", &client.name)
        .replace("{{email}}", &client.email)
        .replace("{{industry}}", &client.industry)
        .replace("{{company}}", &client.company)
        .replace("{{last_contacted_at}}", &client.last_contacted_at)
        .replace("{{sender_name}}", &settings.sender_name)
        .replace("{{ sender_name }}", &settings.sender_name)
        .replace("{{sender_position}}", &settings.sender_position)
        .replace("{{ sender_position }}", &settings.sender_position)
        .replace("{{sender_company}}", &settings.sender_company)
        .replace("{{ sender_company }}", &settings.sender_company)
}

fn parse_generated_json(raw: &str) -> Option<(String, String)> {
    let trimmed = raw.trim();

    let mut candidates = Vec::new();
    candidates.push(trimmed.to_owned());

    let fence_removed = trimmed
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim()
        .to_owned();
    if !fence_removed.is_empty() {
        candidates.push(fence_removed);
    }

    for candidate in candidates {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&candidate) {
            let subject = value
                .get("subject")
                .and_then(|v| v.as_str())
                .map(|v| v.trim().to_owned());
            let body = value
                .get("body")
                .and_then(|v| v.as_str())
                .map(|v| v.trim().to_owned());
            if let (Some(subject), Some(body)) = (subject, body) {
                if !subject.is_empty() && !body.is_empty() {
                    return Some((subject, body));
                }
            }
        }
    }

    None
}

fn parse_generated_email(raw: &str) -> Option<(String, String)> {
    if let Some(pair) = parse_generated_json(raw) {
        return Some(pair);
    }

    let trimmed = raw.trim().trim_matches('`').trim();
    if trimmed.is_empty() {
        return None;
    }

    let normalized = trimmed.replace("\r\n", "\n");
    let mut lines = normalized.lines();
    let first_line = lines.next()?.trim();

    if first_line.to_lowercase().starts_with("subject:") {
        let subject = first_line
            .split_once(':')
            .map(|(_, value)| value.trim().to_owned())
            .unwrap_or_default();
        let body = lines.collect::<Vec<_>>().join("\n").trim().to_owned();
        if !subject.is_empty() && !body.is_empty() {
            return Some((subject, body));
        }
    }

    let mut paragraphs = normalized.split("\n\n");
    let subject = paragraphs.next()?.trim().to_owned();
    let body = paragraphs.collect::<Vec<_>>().join("\n\n").trim().to_owned();
    if subject.len() >= 4 && !body.is_empty() {
        return Some((subject, body));
    }

    None
}

fn looks_like_low_quality_email(subject: &str, body: &str, campaign_name: &str) -> bool {
    let lower_subject = subject.to_lowercase();
    let lower_body = body.to_lowercase();

    if lower_subject.len() < 4 || lower_body.len() < 60 {
        return true;
    }

    // Internal planning labels that should never appear in a sent email
    let structural_flags = [
        "campaign brief",
        "additional notes",
        "call to action:",
        "round name:",
        "goal:",
        "not provided",
        "{name}",
        "{sender_name}",
        "{{name}}",
        "{{sender_name}}",
        "[your name]",
        "[insert",
        "<insert",
        "<your ",
        "lorem ipsum",
    ];

    if structural_flags
        .iter()
        .any(|flag| lower_subject.contains(flag) || lower_body.contains(flag))
    {
        return true;
    }

    // If the campaign name (internal label) appears verbatim in the email, the LLM
    // echoed back the brief instead of writing a real message.
    let cn = campaign_name.trim().to_lowercase();
    if cn.len() > 4 && (lower_subject.contains(&cn) || lower_body.contains(&cn)) {
        return true;
    }

    false
}

fn build_campaign_first_fallback(
    client: &ClientRow,
    settings: &GenerationSettings,
    _campaign_name: &str,
    campaign_goal: &str,
    call_to_action: &str,
    extra_context: &str,
) -> (String, String) {
    // The campaign name is an internal planning label — never put it in the email body.
    let company_reference = if client.company.trim().is_empty() {
        "your team".to_owned()
    } else {
        client.company.clone()
    };

    // Use the goal as the body of the value proposition if it looks like real content
    // (more than a few words). Otherwise fall back to a generic opening.
    let goal_raw = campaign_goal.trim();
    let value_prop = if goal_raw.len() > 12 {
        goal_raw.to_owned()
    } else {
        format!(
            "I believe there's a meaningful opportunity for {} that I'd like to share.",
            company_reference
        )
    };

    let cta = if call_to_action.trim().is_empty() {
        "reply if a brief conversation would be helpful".to_owned()
    } else {
        call_to_action.trim().to_owned()
    };

    let note_line = if extra_context.trim().is_empty() {
        String::new()
    } else {
        format!("\n\n{}", extra_context.trim())
    };

    let subject = format!("Quick note for {}", company_reference);
    let body = format!(
        "Hi {},\n\n{}{}\n\nIf this sounds relevant, I'd love to {}.\n\nBest,\n{}\n{}\n{}",
        client.name,
        value_prop,
        note_line,
        cta,
        settings.sender_name,
        settings.sender_position,
        settings.sender_company,
    );

    (subject, body)
}

fn call_ollama_generate(model: &str, prompt: &str) -> Result<String, String> {
    let client = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(4))
        .timeout_read(Duration::from_secs(30))
        .build();

    let request_body = serde_json::json!({
        "model": model,
        "prompt": prompt,
        "stream": false
    });

    let mut last_err = String::new();
    for base_url in ollama_base_url_candidates() {
        let url = format!("{base_url}/api/generate");
        let response = client.post(&url).send_json(request_body.clone());
        match response {
            Ok(resp) => {
                let parsed = resp
                    .into_json::<serde_json::Value>()
                    .map_err(|e| format!("Failed to decode Ollama response: {e}"))?;
                if let Some(text) = parsed.get("response").and_then(|v| v.as_str()) {
                    return Ok(text.to_owned());
                }
                return Err("Ollama response did not include `response`.".to_owned());
            }
            Err(err) => {
                last_err = err.to_string();
            }
        }
    }

    Err(format!("Could not reach Ollama API: {last_err}"))
}

fn resolve_template_for_client(
    conn: &Connection,
    explicit_template_id: Option<i64>,
    client_industry: &str,
) -> Result<TemplateRow, String> {
    if let Some(id) = explicit_template_id {
        let template = conn
            .query_row(
                "
                SELECT id, name, industry, tone, subject_template, body_template, system_prompt
                FROM templates
                WHERE id = ?1
                LIMIT 1
            ",
                [id],
                |row| {
                    Ok(TemplateRow {
                        id: row.get(0)?,
                        tone: row.get(3)?,
                        subject_template: row.get(4)?,
                        body_template: row.get(5)?,
                        system_prompt: row.get(6)?,
                    })
                },
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(template) = template {
            return Ok(template);
        }
    }

    let industry_template = conn
        .query_row(
            "
            SELECT id, name, industry, tone, subject_template, body_template, system_prompt
            FROM templates
            WHERE active = 1 AND lower(industry) = lower(?1)
            ORDER BY version DESC, id DESC
            LIMIT 1
        ",
            [client_industry],
            |row| {
                Ok(TemplateRow {
                    id: row.get(0)?,
                    tone: row.get(3)?,
                    subject_template: row.get(4)?,
                    body_template: row.get(5)?,
                    system_prompt: row.get(6)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;

    if let Some(template) = industry_template {
        return Ok(template);
    }

    let fallback = conn
        .query_row(
            "
            SELECT id, name, industry, tone, subject_template, body_template, system_prompt
            FROM templates
            WHERE active = 1
            ORDER BY version DESC, id DESC
            LIMIT 1
        ",
            [],
            |row| {
                Ok(TemplateRow {
                    id: row.get(0)?,
                    tone: row.get(3)?,
                    subject_template: row.get(4)?,
                    body_template: row.get(5)?,
                    system_prompt: row.get(6)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;

    fallback.ok_or_else(|| "No templates found. Create one in Templates tab first.".to_owned())
}

fn generate_subject_and_body(
    settings: &GenerationSettings,
    template: &TemplateRow,
    client: &ClientRow,
    instruction: Option<&str>,
    campaign_context: Option<&str>,
    model_override: Option<&str>,
    knowledge_context: Option<&str>,
    use_agent_pipeline: bool,
) -> (String, String, String) {
    let subject_seed = render_template_value(&template.subject_template, client, settings);
    let body_seed = render_template_value(&template.body_template, client, settings);
    let normalized_campaign_context = campaign_context
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("No additional campaign context provided.");
    let campaign_name = normalized_campaign_context
        .lines()
        .find_map(|line| line.strip_prefix("Round name:").map(str::trim))
        .unwrap_or("");
    let campaign_goal = normalized_campaign_context
        .lines()
        .find_map(|line| line.strip_prefix("Goal:").map(str::trim))
        .unwrap_or("");
    let call_to_action = normalized_campaign_context
        .lines()
        .find_map(|line| line.strip_prefix("Call to action:").map(str::trim))
        .unwrap_or("");
    let extra_context = normalized_campaign_context
        .lines()
        .find_map(|line| line.strip_prefix("Additional notes:").map(str::trim))
        .unwrap_or("");

    let system_prompt = if template.system_prompt.trim().is_empty() {
        settings.default_system_prompt.clone()
    } else {
        template.system_prompt.clone()
    };

    let model = model_override.unwrap_or(&settings.model);
    let kctx = knowledge_context.unwrap_or("");
    let fallback_pair = build_campaign_first_fallback(
        client,
        settings,
        campaign_name,
        campaign_goal,
        call_to_action,
        extra_context,
    );

    // Agent pipeline: planner → writer
    if use_agent_pipeline {
        let plan = run_planner_step(
            model,
            normalized_campaign_context,
            kctx,
            client,
            settings,
        )
        .unwrap_or_else(|_| String::new());

        if !plan.is_empty() {
            let (subject, body) = run_writer_step(
                model,
                &plan,
                normalized_campaign_context,
                kctx,
                template,
                client,
                settings,
                instruction,
            );
            if !looks_like_low_quality_email(&subject, &body, campaign_name) {
                let meta = serde_json::json!({
                    "model": model,
                    "template_id": template.id,
                    "mode": "agent_pipeline"
                });
                return (subject, body, meta.to_string());
            }
        }
        // Planner failed or writer produced bad output — fall through to single-shot
    }

    let knowledge_section = if kctx.trim().is_empty() {
        String::new()
    } else {
        format!("\n\nKnowledge base (use as primary source of truth for sender's offering):\n{kctx}")
    };

    let prompt = format!(
        "{system_prompt}\n\nWrite one polished outbound business email from the sender to the recipient.\n\nRULES:\n- This is a real email that will be sent, not planning notes.\n- The \"Round name\" in the brief is an INTERNAL tracking label. Never mention it in the email.\n- Do NOT echo the labels \"Goal:\", \"Call to action:\", \"Additional notes:\", or \"Round name:\" into the email.\n- Do NOT use placeholders like [your name] or <insert>.\n- Incorporate the goal and call to action naturally — don't quote them verbatim.\n- Keep the email concise and human. No filler sections like \"About us\" unless the goal specifically requires it.\n- If a knowledge base is provided, draw facts and value propositions directly from it.\n\nOutput format (exactly):\nSubject: <subject line>\n<email body — start with the greeting>\n\nCampaign brief:\n{campaign_context}{knowledge_section}\n\nSender:\nName: {sender_name}\nTitle: {sender_position}\nCompany: {sender_company}\n\nRecipient:\nName: {name}\nEmail: {email}\nCompany: {company}\nIndustry: {industry}\nLast contacted: {last_contacted}\n\nTone:\n{tone}\n\nReference idea:\nSubject idea: {subject_seed}\nBody idea: {body_seed}\n\nExtra rewrite instruction:\n{instruction}",
        tone = template.tone,
        industry = client.industry,
        campaign_context = normalized_campaign_context,
        sender_name = settings.sender_name,
        sender_position = settings.sender_position,
        sender_company = settings.sender_company,
        name = client.name,
        email = client.email,
        company = client.company,
        last_contacted = client.last_contacted_at,
        instruction = instruction.unwrap_or("none")
    );

    let response = call_ollama_generate(model, &prompt);
    match response {
        Ok(text) => {
            if let Some((subject, body)) = parse_generated_email(&text) {
                if looks_like_low_quality_email(&subject, &body, campaign_name) {
                    let meta = serde_json::json!({
                        "model": model,
                        "template_id": template.id,
                        "mode": "quality_fallback"
                    });
                    return (fallback_pair.0, fallback_pair.1, meta.to_string());
                }
                let meta = serde_json::json!({
                    "model": model,
                    "template_id": template.id,
                    "mode": "ollama"
                });
                (subject, body, meta.to_string())
            } else {
                let meta = serde_json::json!({
                    "model": model,
                    "template_id": template.id,
                    "mode": "ollama_text_fallback"
                });
                (fallback_pair.0, fallback_pair.1, meta.to_string())
            }
        }
        Err(err) => {
            let fallback = serde_json::json!({
                "model": model,
                "template_id": template.id,
                "mode": "template_fallback",
                "error": err
            });
            (fallback_pair.0, fallback_pair.1, fallback.to_string())
        }
    }
}

fn apply_campaign_first_seed(
    template: &mut TemplateRow,
    campaign_name: &str,
    campaign_goal: &str,
    call_to_action: &str,
    extra_context: &str,
) {
    let clean_round_name = campaign_name.trim();
    let clean_goal = campaign_goal.trim();
    let clean_cta = call_to_action.trim();
    let clean_notes = extra_context.trim();

    template.subject_template = if clean_round_name.is_empty() {
        "A note for {{company}}".to_owned()
    } else {
        format!("{clean_round_name} | {{company}}")
    };

    template.body_template = [clean_goal, clean_notes, clean_cta]
        .iter()
        .filter(|value| !value.is_empty())
        .cloned()
        .collect::<Vec<_>>()
        .join(" ");
}

fn now_epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn generation_summary(meta_json: &str) -> (String, String, bool) {
    let meta = serde_json::from_str::<serde_json::Value>(meta_json).unwrap_or(serde_json::Value::Null);
    let mode = meta
        .get("mode")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown")
        .to_owned();

    match mode.as_str() {
        "ollama" => (mode, "AI-personalized draft".to_owned(), false),
        "ollama_text_fallback" => (
            mode,
            "Draft needs review: the writing engine returned plain text, not a structured rewrite.".to_owned(),
            true,
        ),
        "template_fallback" => (
            mode,
            "Draft needs review: the system used the base template because the writing engine was unavailable.".to_owned(),
            true,
        ),
        _ => (
            mode,
            "Draft prepared. Review carefully before approval.".to_owned(),
            true,
        ),
    }
}

fn build_campaign_context(
    campaign_name: &str,
    campaign_goal: &str,
    call_to_action: &str,
    extra_context: &str,
) -> String {
    let mut lines = Vec::new();

    if !campaign_name.trim().is_empty() {
        lines.push(format!("Round name: {}", campaign_name.trim()));
    }
    if !campaign_goal.trim().is_empty() {
        lines.push(format!("Goal: {}", campaign_goal.trim()));
    }
    if !call_to_action.trim().is_empty() {
        lines.push(format!("Call to action: {}", call_to_action.trim()));
    }
    if !extra_context.trim().is_empty() {
        lines.push(format!("Additional notes: {}", extra_context.trim()));
    }

    if lines.is_empty() {
        "Goal: Write a relevant outreach email.".to_owned()
    } else {
        lines.join("\n")
    }
}

fn delete_draft_related_records(conn: &Connection, draft_id: i64) -> Result<(), String> {
    conn.execute("DELETE FROM send_history WHERE draft_id = ?1", [draft_id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM export_history WHERE draft_id = ?1", [draft_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn cleanup_empty_campaign(conn: &Connection, campaign_id: i64) -> Result<(), String> {
    let draft_count: i64 = conn
        .query_row(
            "SELECT COUNT(1) FROM drafts WHERE campaign_id = ?1",
            [campaign_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    if draft_count == 0 {
        conn.execute("DELETE FROM generation_jobs WHERE campaign_id = ?1", [campaign_id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM campaigns WHERE id = ?1", [campaign_id])
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

fn load_recent_clients(conn: &Connection, max_clients: i64) -> Result<Vec<ClientRow>, String> {
    let mut client_stmt = conn
        .prepare(
            "
            SELECT id, name, email, industry, COALESCE(company, ''), COALESCE(last_contacted_at, '')
            FROM clients
            ORDER BY updated_at DESC, id DESC
            LIMIT ?1
        ",
        )
        .map_err(|e| e.to_string())?;

    let rows = client_stmt
        .query_map([max_clients], |row| {
            Ok(ClientRow {
                id: row.get(0)?,
                name: row.get(1)?,
                email: row.get(2)?,
                industry: row.get(3)?,
                company: row.get(4)?,
                last_contacted_at: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut clients = Vec::new();
    for row in rows {
        clients.push(row.map_err(|e| e.to_string())?);
    }

    Ok(clients)
}

fn load_draft_record_by_id(conn: &Connection, draft_id: i64) -> Result<DraftRecord, String> {
    conn.query_row(
        "
        SELECT d.id,
               d.campaign_id,
               COALESCE(cp.name, 'Round'),
               d.client_id,
               c.name,
               c.email,
               c.industry,
               COALESCE(c.company, ''),
               d.subject,
               d.body,
               d.status,
               COALESCE(t.name, 'Template'),
               d.created_at,
               COALESCE(d.generation_meta_json, '{}')
        FROM drafts d
        JOIN clients c ON c.id = d.client_id
        LEFT JOIN campaigns cp ON cp.id = d.campaign_id
        LEFT JOIN templates t ON t.id = cp.template_id
        WHERE d.id = ?1
        LIMIT 1
        ",
        [draft_id],
        |row| {
            let meta_json: String = row.get(13)?;
            let (generation_mode, generation_label, needs_attention) = generation_summary(&meta_json);
            Ok(DraftRecord {
                id: row.get(0)?,
                campaign_id: row.get(1)?,
                campaign_name: row.get(2)?,
                client_id: row.get(3)?,
                client_name: row.get(4)?,
                client_email: row.get(5)?,
                client_industry: row.get(6)?,
                client_company: row.get(7)?,
                subject: row.get(8)?,
                body: row.get(9)?,
                status: row.get(10)?,
                template_name: row.get(11)?,
                created_at: row.get(12)?,
                generation_mode,
                generation_label,
                needs_attention,
            })
        },
    )
    .map_err(|e| e.to_string())
}

fn emit_generation_progress(
    app: &tauri::AppHandle,
    conn: &Connection,
    job: GenerationJobStatus,
    draft_id: Option<i64>,
) {
    let draft = draft_id.and_then(|id| load_draft_record_by_id(conn, id).ok());
    let _ = app.emit(
        "generation-progress",
        GenerationProgressEvent { job, draft },
    );
}

fn update_generation_job_counts(
    conn: &Connection,
    job_id: i64,
    generated_count: usize,
    flagged_count: usize,
    failed_count: usize,
    current_client_name: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        "
        UPDATE generation_jobs
        SET generated_count = ?1,
            flagged_count = ?2,
            failed_count = ?3,
            current_client_name = ?4,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?5
    ",
        params![
            generated_count as i64,
            flagged_count as i64,
            failed_count as i64,
            current_client_name,
            job_id
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn reconcile_stale_generation_jobs(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "
        UPDATE generation_jobs
        SET status = 'failed',
            error_message = COALESCE(error_message, 'Generation was interrupted when the app closed. Please start the round again.'),
            completed_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE status = 'running'
          AND strftime('%s','now') - strftime('%s', updated_at) > 120
    ",
        [],
    )
    .map_err(|e| e.to_string())?;

    conn.execute(
        "
        UPDATE campaigns
        SET status = 'draft'
        WHERE id IN (
            SELECT campaign_id
            FROM generation_jobs
            WHERE status = 'failed'
              AND error_message = 'Generation was interrupted when the app closed. Please start the round again.'
        )
    ",
        [],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn check_ollama_health() -> Result<OllamaHealth, String> {
    if let Some(ollama_bin) = find_ollama_binary() {
        let output = Command::new(&ollama_bin).arg("--version").output();
        if let Ok(result) = output {
            if result.status.success() {
                let stdout = String::from_utf8_lossy(&result.stdout).trim().to_owned();
                let stderr = String::from_utf8_lossy(&result.stderr).trim().to_owned();
                let version = if stdout.is_empty() {
                    if stderr.is_empty() {
                        None
                    } else {
                        Some(stderr)
                    }
                } else {
                    Some(stdout)
                };

                return Ok(OllamaHealth {
                    installed: true,
                    version,
                    message: format!("Ollama is ready at {}.", ollama_bin.to_string_lossy()),
                });
            }
        }
    }

    match check_ollama_http_health() {
        Some((base_url, version)) => Ok(OllamaHealth {
            installed: true,
            version,
            message: format!("Ollama server is reachable at {base_url}."),
        }),
        None => Ok(OllamaHealth {
            installed: false,
            version: None,
            message: "Ollama is not installed in PATH and no Ollama HTTP server responded. Set OLLAMA_BASE_URL if needed.".to_owned(),
        }),
    }
}

#[tauri::command]
fn initialize_local_store(app: tauri::AppHandle) -> Result<StoreStatus, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&app_data_dir).map_err(|e| e.to_string())?;

    let database_path = app_data_dir.join("assistant.db");
    let created = !database_path.exists();

    let conn = Connection::open(&database_path).map_err(|e| e.to_string())?;
    ensure_schema(&conn)?;

    Ok(StoreStatus {
        database_path: database_path.to_string_lossy().to_string(),
        created,
    })
}

#[tauri::command]
fn save_imported_clients(
    app: tauri::AppHandle,
    payload: ClientImportPayload,
) -> Result<ImportResult, String> {
    if payload.mapping.name.trim().is_empty()
        || payload.mapping.email.trim().is_empty()
        || payload.mapping.industry.trim().is_empty()
    {
        return Err("Required mapping fields are missing.".to_owned());
    }

    let mut conn = open_database(&app)?;
    ensure_schema(&conn)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let mapping_json = serde_json::to_string(&payload.mapping).map_err(|e| e.to_string())?;
    tx.execute(
        "
        INSERT INTO import_profiles (name, source_file_name, column_mapping_json)
        VALUES (?1, ?2, ?3)
    ",
        (&payload.profile_name, &payload.source_file_name, &mapping_json),
    )
    .map_err(|e| e.to_string())?;
    let profile_id = tx.last_insert_rowid();

    let mut imported_count: usize = 0;
    let mut skipped_count: usize = 0;

    for row in &payload.rows {
        let name = row
            .get(&payload.mapping.name)
            .map(|v| v.trim().to_owned())
            .unwrap_or_default();
        let email = row
            .get(&payload.mapping.email)
            .map(|v| v.trim().to_owned())
            .unwrap_or_default();
        let industry = row
            .get(&payload.mapping.industry)
            .map(|v| v.trim().to_owned())
            .unwrap_or_default();

        if name.is_empty() || email.is_empty() || industry.is_empty() {
            skipped_count += 1;
            continue;
        }

        let company = if payload.mapping.company.trim().is_empty() {
            String::new()
        } else {
            row.get(&payload.mapping.company)
                .map(|v| v.trim().to_owned())
                .unwrap_or_default()
        };

        let last_contacted_at = if payload.mapping.last_contacted_at.trim().is_empty() {
            String::new()
        } else {
            row.get(&payload.mapping.last_contacted_at)
                .map(|v| v.trim().to_owned())
                .unwrap_or_default()
        };

        let existing_id = tx
            .query_row(
                "SELECT id FROM clients WHERE email = ?1 LIMIT 1",
                [&email],
                |row| row.get::<usize, i64>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;

        match existing_id {
            Some(client_id) => {
                tx.execute(
                    "
                    UPDATE clients
                    SET name = ?1,
                        industry = ?2,
                        company = ?3,
                        last_contacted_at = ?4,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?5
                ",
                    (&name, &industry, &company, &last_contacted_at, &client_id),
                )
                .map_err(|e| e.to_string())?;
            }
            None => {
                tx.execute(
                    "
                    INSERT INTO clients (name, email, industry, company, last_contacted_at, custom_fields_json)
                    VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                ",
                    (&name, &email, &industry, &company, &last_contacted_at, "{}"),
                )
                .map_err(|e| e.to_string())?;
            }
        }

        imported_count += 1;
    }

    tx.commit().map_err(|e| e.to_string())?;

    Ok(ImportResult {
        imported_count,
        skipped_count,
        profile_id,
    })
}

#[tauri::command]
fn count_clients(app: tauri::AppHandle) -> Result<ClientCount, String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;
    let total: i64 = conn
        .query_row("SELECT COUNT(1) FROM clients", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    Ok(ClientCount { total })
}

#[tauri::command]
fn list_clients(app: tauri::AppHandle) -> Result<Vec<StoredClientRecord>, String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;

    let mut statement = conn
        .prepare(
            "
            SELECT id,
                   name,
                   email,
                   industry,
                   COALESCE(company, ''),
                   COALESCE(last_contacted_at, ''),
                   updated_at
            FROM clients
            ORDER BY updated_at DESC, id DESC
            LIMIT 100
        ",
        )
        .map_err(|e| e.to_string())?;

    let rows = statement
        .query_map([], |row| {
            Ok(StoredClientRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                email: row.get(2)?,
                industry: row.get(3)?,
                company: row.get(4)?,
                last_contacted_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut clients = Vec::new();
    for row in rows {
        clients.push(row.map_err(|e| e.to_string())?);
    }
    Ok(clients)
}

#[tauri::command]
fn add_single_client(app: tauri::AppHandle, payload: SingleClientPayload) -> Result<(), String> {
    let name = payload.name.trim().to_owned();
    let email = payload.email.trim().to_lowercase();
    if name.is_empty() || email.is_empty() {
        return Err("Name and email are required.".to_owned());
    }
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;
    conn.execute(
        "INSERT INTO clients (name, email, company, industry, updated_at)
         VALUES (?1, ?2, ?3, ?4, CURRENT_TIMESTAMP)
         ON CONFLICT(email) DO UPDATE SET
           name = excluded.name,
           company = COALESCE(excluded.company, clients.company),
           industry = COALESCE(excluded.industry, clients.industry),
           updated_at = CURRENT_TIMESTAMP",
        params![
            name,
            email,
            payload.company.as_deref().map(str::trim).filter(|s| !s.is_empty()),
            payload.industry.as_deref().map(str::trim).filter(|s| !s.is_empty()),
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn bulk_approve_drafts(
    app: tauri::AppHandle,
    payload: BulkApprovePayload,
) -> Result<BulkApproveResult, String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;
    let approved_count = if let Some(cid) = payload.campaign_id {
        conn.execute(
            "UPDATE drafts SET status = 'approved', updated_at = CURRENT_TIMESTAMP WHERE status = 'review_required' AND campaign_id = ?1",
            params![cid],
        )
        .map_err(|e| e.to_string())?
    } else {
        conn.execute(
            "UPDATE drafts SET status = 'approved', updated_at = CURRENT_TIMESTAMP WHERE status = 'review_required'",
            [],
        )
        .map_err(|e| e.to_string())?
    };
    Ok(BulkApproveResult { approved_count })
}

#[tauri::command]
fn seed_default_templates(app: tauri::AppHandle) -> Result<usize, String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;

    let existing_count: i64 = conn
        .query_row("SELECT COUNT(1) FROM templates", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;

    if existing_count > 0 {
        return Ok(0);
    }

    let defaults = [
        (
            "Retail Warm Intro",
            "Retail",
            "Friendly",
            "Quick idea for {{company}} this quarter",
            "Hi {{name}},\n\nI noticed {{company}} operates in {{industry}}. I wanted to share a short idea that can help improve response rates this quarter.\n\nIf helpful, I can send a 3-step outline tailored for your team.\n\nBest,\n{{sender_name}}",
            "You write concise, warm sales emails for retail clients. Keep the message under 140 words.",
        ),
        (
            "Healthcare Follow-up",
            "Healthcare",
            "Formal",
            "Follow-up regarding support for {{company}}",
            "Hello {{name}},\n\nFollowing up on my previous note. Based on {{company}}'s current focus in {{industry}}, I prepared a concise recommendation that aligns with your workflow and compliance needs.\n\nWould a 15-minute review this week be useful?\n\nRegards,\n{{sender_name}}",
            "You write compliance-conscious, professional outreach for healthcare decision makers.",
        ),
        (
            "Manufacturing Re-engagement",
            "Manufacturing",
            "Follow-up",
            "Reconnecting with {{company}}",
            "Hi {{name}},\n\nReaching out again with a practical plan we use for teams in {{industry}} to reduce follow-up overhead while keeping client communication consistent.\n\nIf timing is right, I can share a short draft sequence for your review.\n\nThanks,\n{{sender_name}}",
            "You write clear, practical B2B messages for operations teams in manufacturing.",
        ),
    ];

    let mut inserted = 0usize;
    for template in defaults {
        conn.execute(
            "
            INSERT INTO templates (name, industry, tone, subject_template, body_template, system_prompt, version, active)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, 1)
        ",
            (
                template.0,
                template.1,
                template.2,
                template.3,
                template.4,
                template.5,
            ),
        )
        .map_err(|e| e.to_string())?;
        inserted += 1;
    }

    Ok(inserted)
}

#[tauri::command]
fn list_templates(app: tauri::AppHandle) -> Result<Vec<TemplateRecord>, String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;

    let mut statement = conn
        .prepare(
            "
            SELECT id, name, industry, tone, subject_template, body_template, system_prompt, version, active
            FROM templates
            ORDER BY created_at DESC, id DESC
        ",
        )
        .map_err(|e| e.to_string())?;

    let rows = statement
        .query_map([], |row| {
            Ok(TemplateRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                industry: row.get(2)?,
                tone: row.get(3)?,
                subject_template: row.get(4)?,
                body_template: row.get(5)?,
                system_prompt: row.get(6)?,
                version: row.get(7)?,
                active: row.get::<usize, i64>(8)? == 1,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut templates = Vec::new();
    for record in rows {
        templates.push(record.map_err(|e| e.to_string())?);
    }
    Ok(templates)
}

#[tauri::command]
fn upsert_template(
    app: tauri::AppHandle,
    payload: TemplateUpsertPayload,
) -> Result<TemplateUpsertResult, String> {
    if payload.name.trim().is_empty()
        || payload.industry.trim().is_empty()
        || payload.subject_template.trim().is_empty()
        || payload.body_template.trim().is_empty()
    {
        return Err("Template name, industry, subject, and body are required.".to_owned());
    }

    let conn = open_database(&app)?;
    ensure_schema(&conn)?;

    if let Some(id) = payload.id {
        let current_version: Option<i64> = conn
            .query_row("SELECT version FROM templates WHERE id = ?1", [id], |row| row.get(0))
            .optional()
            .map_err(|e| e.to_string())?;

        let next_version = current_version.unwrap_or(0) + 1;
        conn.execute(
            "
            UPDATE templates
            SET name = ?1,
                industry = ?2,
                tone = ?3,
                subject_template = ?4,
                body_template = ?5,
                system_prompt = ?6,
                active = ?7,
                version = ?8
            WHERE id = ?9
        ",
            params![
                payload.name,
                payload.industry,
                payload.tone,
                payload.subject_template,
                payload.body_template,
                payload.system_prompt,
                if payload.active { 1 } else { 0 },
                next_version,
                id
            ],
        )
        .map_err(|e| e.to_string())?;

        Ok(TemplateUpsertResult {
            id,
            version: next_version,
        })
    } else {
        conn.execute(
            "
            INSERT INTO templates (name, industry, tone, subject_template, body_template, system_prompt, version, active)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7)
        ",
            params![
                payload.name,
                payload.industry,
                payload.tone,
                payload.subject_template,
                payload.body_template,
                payload.system_prompt,
                if payload.active { 1 } else { 0 }
            ],
        )
        .map_err(|e| e.to_string())?;

        Ok(TemplateUpsertResult {
            id: conn.last_insert_rowid(),
            version: 1,
        })
    }
}

#[tauri::command]
fn get_generation_settings(app: tauri::AppHandle) -> Result<GenerationSettings, String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;

    let model = resolve_generation_model(&conn)?;
    let default_system_prompt = get_setting_value(&conn, "default_system_prompt")?.unwrap_or_else(|| {
        "You write concise executive outbound emails for high-value business development. Sound natural, credible, and commercially sharp. Never invent facts.".to_owned()
    });
    let sender_name = get_setting_value(&conn, "sender_name")?.unwrap_or_default();
    let sender_position = get_setting_value(&conn, "sender_position")?.unwrap_or_default();
    let sender_company = get_setting_value(&conn, "sender_company")?.unwrap_or_default();

    Ok(GenerationSettings {
        model,
        default_system_prompt,
        sender_name,
        sender_position,
        sender_company,
    })
}

#[tauri::command]
fn set_generation_settings(
    app: tauri::AppHandle,
    payload: GenerationSettingsPayload,
) -> Result<(), String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;
    set_setting_value(&conn, "generation_model", &payload.model)?;
    set_setting_value(&conn, "default_system_prompt", &payload.default_system_prompt)?;
    set_setting_value(&conn, "sender_name", &payload.sender_name)?;
    set_setting_value(&conn, "sender_position", &payload.sender_position)?;
    set_setting_value(&conn, "sender_company", &payload.sender_company)?;
    Ok(())
}

#[tauri::command]
fn list_ollama_models(app: tauri::AppHandle) -> Result<AvailableModels, String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;

    let models = list_ollama_models_internal();

    Ok(AvailableModels { models })
}

#[tauri::command]
fn generate_drafts(
    app: tauri::AppHandle,
    payload: DraftGenerationPayload,
) -> Result<DraftGenerationResult, String> {
    let mut conn = open_database(&app)?;
    ensure_schema(&conn)?;

    let settings = get_generation_settings(app.clone())?;
    let model = payload.model.unwrap_or(settings.model.clone());
    let max_clients = payload.max_clients.unwrap_or(50).max(1).min(500) as i64;
    let campaign_name = payload
        .campaign_name
        .unwrap_or_else(|| format!("Outreach Round {}", now_epoch()));
    let campaign_goal = payload.campaign_goal.unwrap_or_default();
    let call_to_action = payload.call_to_action.unwrap_or_default();
    let extra_context = payload.extra_context.unwrap_or_default();
    let campaign_context = build_campaign_context(
        &campaign_name,
        &campaign_goal,
        &call_to_action,
        &extra_context,
    );

    let fallback_template = resolve_template_for_client(&conn, payload.template_id, "")?;
    let booking_url = get_setting_value(&conn, "booking_url")?.unwrap_or_default();
    let campaign_context = if !booking_url.is_empty() {
        format!("{campaign_context}\nBooking link (include naturally as the tour scheduling CTA): {booking_url}")
    } else {
        campaign_context
    };

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "
        INSERT INTO campaigns (name, filter_json, template_id, status)
        VALUES (?1, ?2, ?3, 'generating')
    ",
        params![
            campaign_name,
            serde_json::json!({
                "campaign_goal": campaign_goal,
                "call_to_action": call_to_action,
                "extra_context": extra_context,
                "max_clients": max_clients
            })
            .to_string(),
            fallback_template.id
        ],
    )
    .map_err(|e| e.to_string())?;

    let campaign_id = tx.last_insert_rowid();

    let clients = load_recent_clients(&tx, max_clients)?;

    if clients.is_empty() {
        return Err("No clients found. Import client data first.".to_owned());
    }

    let mut generated_count = 0usize;
    let mut flagged_count = 0usize;
    let mut failed_count = 0usize;

    for client in clients {
        let mut template = match resolve_template_for_client(&tx, payload.template_id, &client.industry) {
            Ok(t) => t,
            Err(_) => {
                failed_count += 1;
                continue;
            }
        };

        if payload.template_id.is_none() {
            apply_campaign_first_seed(
                &mut template,
                &campaign_name,
                &campaign_goal,
                &call_to_action,
                &extra_context,
            );
        }

        let kctx = load_knowledge_context(&tx, Some(campaign_id), Some(client.id));
        let use_agent = payload.use_agent_pipeline.unwrap_or(false);
        let (subject, body, meta) = generate_subject_and_body(
            &GenerationSettings {
                model: model.clone(),
                default_system_prompt: settings.default_system_prompt.clone(),
                sender_name: settings.sender_name.clone(),
                sender_position: settings.sender_position.clone(),
                sender_company: settings.sender_company.clone(),
            },
            &template,
            &client,
            None,
            Some(&campaign_context),
            Some(&model),
            Some(&kctx),
            use_agent,
        );

        tx.execute(
            "
            INSERT INTO drafts (campaign_id, client_id, subject, body, status, generation_meta_json)
            VALUES (?1, ?2, ?3, ?4, 'review_required', ?5)
        ",
            params![campaign_id, client.id, subject, body, meta],
        )
        .map_err(|e| e.to_string())?;

        generated_count += 1;
        let (_, _, needs_attention) = generation_summary(&meta);
        if needs_attention {
            flagged_count += 1;
        }
    }

    tx.execute(
        "UPDATE campaigns SET status = 'review_required' WHERE id = ?1",
        [campaign_id],
    )
    .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;

    Ok(DraftGenerationResult {
        campaign_id,
        generated_count,
        flagged_count,
        failed_count,
    })
}

#[tauri::command]
fn start_generate_drafts(
    app: tauri::AppHandle,
    payload: DraftGenerationPayload,
) -> Result<GenerationJobStatus, String> {
    let mut conn = open_database(&app)?;
    ensure_schema(&conn)?;

    let settings = get_generation_settings(app.clone())?;
    let model = payload.model.clone().unwrap_or(settings.model.clone());
    let max_clients = payload.max_clients.unwrap_or(50).max(1).min(500) as i64;
    let campaign_name = payload
        .campaign_name
        .clone()
        .unwrap_or_else(|| format!("Outreach Round {}", now_epoch()));
    let campaign_goal = payload.campaign_goal.clone().unwrap_or_default();
    let call_to_action = payload.call_to_action.clone().unwrap_or_default();
    let extra_context = payload.extra_context.clone().unwrap_or_default();
    let campaign_context = build_campaign_context(
        &campaign_name,
        &campaign_goal,
        &call_to_action,
        &extra_context,
    );

    let fallback_template = resolve_template_for_client(&conn, payload.template_id, "")?;
    let booking_url = get_setting_value(&conn, "booking_url")?.unwrap_or_default();
    let campaign_context = if !booking_url.is_empty() {
        format!("{campaign_context}\nBooking link (include naturally as the tour scheduling CTA): {booking_url}")
    } else {
        campaign_context
    };
    let clients = load_recent_clients(&conn, max_clients)?;
    if clients.is_empty() {
        return Err("No clients found. Import client data first.".to_owned());
    }
    let total_count = clients.len();

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "
        INSERT INTO campaigns (name, filter_json, template_id, status)
        VALUES (?1, ?2, ?3, 'generating')
    ",
        params![
            campaign_name,
            serde_json::json!({
                "campaign_goal": campaign_goal,
                "call_to_action": call_to_action,
                "extra_context": extra_context,
                "max_clients": max_clients
            })
            .to_string(),
            fallback_template.id
        ],
    )
    .map_err(|e| e.to_string())?;
    let campaign_id = tx.last_insert_rowid();

    tx.execute(
        "
        INSERT INTO generation_jobs (status, campaign_id, total_count, generated_count, flagged_count, failed_count)
        VALUES ('running', ?1, ?2, 0, 0, 0)
    ",
        params![campaign_id, total_count as i64],
    )
    .map_err(|e| e.to_string())?;
    let job_id = tx.last_insert_rowid();
    tx.commit().map_err(|e| e.to_string())?;

    let app_handle = app.clone();
    let payload_template_id = payload.template_id;
    let payload_use_agent = payload.use_agent_pipeline.unwrap_or(false);

    thread::spawn(move || {
        let run_result: Result<(), String> = (|| {
            let conn = open_database(&app_handle)?;
            ensure_schema(&conn)?;

            let mut generated_count = 0usize;
            let mut flagged_count = 0usize;
            let mut failed_count = 0usize;

            emit_generation_progress(
                &app_handle,
                &conn,
                GenerationJobStatus {
                    id: job_id,
                    status: "running".to_owned(),
                    campaign_id,
                    total_count,
                    generated_count,
                    flagged_count,
                    failed_count,
                    current_client_name: None,
                    error_message: None,
                },
                None,
            );

            for client in clients {
                update_generation_job_counts(
                    &conn,
                    job_id,
                    generated_count,
                    flagged_count,
                    failed_count,
                    Some(&client.name),
                )?;
                emit_generation_progress(
                    &app_handle,
                    &conn,
                    GenerationJobStatus {
                        id: job_id,
                        status: "running".to_owned(),
                        campaign_id,
                        total_count,
                        generated_count,
                        flagged_count,
                        failed_count,
                        current_client_name: Some(client.name.clone()),
                        error_message: None,
                    },
                    None,
                );

                let mut template = match resolve_template_for_client(&conn, payload_template_id, &client.industry) {
                    Ok(t) => t,
                    Err(_) => {
                        failed_count += 1;
                        update_generation_job_counts(
                            &conn,
                            job_id,
                            generated_count,
                            flagged_count,
                            failed_count,
                            Some(&client.name),
                        )?;
                        emit_generation_progress(
                            &app_handle,
                            &conn,
                            GenerationJobStatus {
                                id: job_id,
                                status: "running".to_owned(),
                                campaign_id,
                                total_count,
                                generated_count,
                                flagged_count,
                                failed_count,
                                current_client_name: Some(client.name.clone()),
                                error_message: None,
                            },
                            None,
                        );
                        continue;
                    }
                };

                if payload_template_id.is_none() {
                    apply_campaign_first_seed(
                        &mut template,
                        &campaign_name,
                        &campaign_goal,
                        &call_to_action,
                        &extra_context,
                    );
                }

                let kctx = load_knowledge_context(&conn, Some(campaign_id), Some(client.id));
                let (subject, body, meta) = generate_subject_and_body(
                    &GenerationSettings {
                        model: model.clone(),
                        default_system_prompt: settings.default_system_prompt.clone(),
                        sender_name: settings.sender_name.clone(),
                        sender_position: settings.sender_position.clone(),
                        sender_company: settings.sender_company.clone(),
                    },
                    &template,
                    &client,
                    None,
                    Some(&campaign_context),
                    Some(&model),
                    Some(&kctx),
                    payload_use_agent,
                );

                conn.execute(
                    "
                    INSERT INTO drafts (campaign_id, client_id, subject, body, status, generation_meta_json)
                    VALUES (?1, ?2, ?3, ?4, 'review_required', ?5)
                ",
                    params![campaign_id, client.id, subject, body, meta],
                )
                .map_err(|e| e.to_string())?;
                let draft_id = conn.last_insert_rowid();

                generated_count += 1;
                let (_, _, needs_attention) = generation_summary(&meta);
                if needs_attention {
                    flagged_count += 1;
                }

                update_generation_job_counts(
                    &conn,
                    job_id,
                    generated_count,
                    flagged_count,
                    failed_count,
                    Some(&client.name),
                )?;
                emit_generation_progress(
                    &app_handle,
                    &conn,
                    GenerationJobStatus {
                        id: job_id,
                        status: "running".to_owned(),
                        campaign_id,
                        total_count,
                        generated_count,
                        flagged_count,
                        failed_count,
                        current_client_name: Some(client.name.clone()),
                        error_message: None,
                    },
                    Some(draft_id),
                );
            }

            conn.execute(
                "
                UPDATE campaigns
                SET status = CASE
                    WHEN ?2 > 0 THEN 'review_required'
                    ELSE 'draft'
                END
                WHERE id = ?1
            ",
                params![campaign_id, generated_count as i64],
            )
            .map_err(|e| e.to_string())?;

            conn.execute(
                "
                UPDATE generation_jobs
                SET status = 'completed',
                    current_client_name = NULL,
                    updated_at = CURRENT_TIMESTAMP,
                    completed_at = CURRENT_TIMESTAMP
                WHERE id = ?1
            ",
                [job_id],
            )
            .map_err(|e| e.to_string())?;
            emit_generation_progress(
                &app_handle,
                &conn,
                GenerationJobStatus {
                    id: job_id,
                    status: "completed".to_owned(),
                    campaign_id,
                    total_count,
                    generated_count,
                    flagged_count,
                    failed_count,
                    current_client_name: None,
                    error_message: None,
                },
                None,
            );

            Ok(())
        })();

        if let Err(error_message) = run_result {
            if let Ok(conn) = open_database(&app_handle) {
                let _ = ensure_schema(&conn);
                let _ = conn.execute(
                    "
                    UPDATE generation_jobs
                    SET status = 'failed',
                        error_message = ?2,
                        updated_at = CURRENT_TIMESTAMP,
                        completed_at = CURRENT_TIMESTAMP
                    WHERE id = ?1
                ",
                    params![job_id, error_message],
                );
                let _ = conn.execute(
                    "UPDATE campaigns SET status = 'draft' WHERE id = ?1",
                    [campaign_id],
                );
                if let Ok(Some(job)) = get_generation_job_status(app_handle.clone()) {
                    emit_generation_progress(&app_handle, &conn, job, None);
                }
            }
        }
    });

    Ok(GenerationJobStatus {
        id: job_id,
        status: "running".to_owned(),
        campaign_id,
        total_count,
        generated_count: 0,
        flagged_count: 0,
        failed_count: 0,
        current_client_name: None,
        error_message: None,
    })
}

#[tauri::command]
fn get_generation_job_status(app: tauri::AppHandle) -> Result<Option<GenerationJobStatus>, String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;
    reconcile_stale_generation_jobs(&conn)?;

    conn.query_row(
        "
        SELECT id,
               status,
               campaign_id,
               total_count,
               generated_count,
               flagged_count,
               failed_count,
               current_client_name,
               error_message
        FROM generation_jobs
        ORDER BY id DESC
        LIMIT 1
    ",
        [],
        |row| {
            Ok(GenerationJobStatus {
                id: row.get(0)?,
                status: row.get(1)?,
                campaign_id: row.get::<usize, i64>(2)?,
                total_count: row.get::<usize, i64>(3)? as usize,
                generated_count: row.get::<usize, i64>(4)? as usize,
                flagged_count: row.get::<usize, i64>(5)? as usize,
                failed_count: row.get::<usize, i64>(6)? as usize,
                current_client_name: row.get(7).ok(),
                error_message: row.get(8).ok(),
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn list_campaigns(app: tauri::AppHandle) -> Result<Vec<CampaignRecord>, String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;

    let mut statement = conn
        .prepare(
            "
            SELECT cp.id,
                   cp.name,
                   cp.status,
                   cp.created_at,
                   COUNT(d.id) AS draft_count
            FROM campaigns cp
            LEFT JOIN drafts d ON d.campaign_id = cp.id
            GROUP BY cp.id, cp.name, cp.status, cp.created_at
            ORDER BY cp.created_at DESC, cp.id DESC
        ",
        )
        .map_err(|e| e.to_string())?;

    let rows = statement
        .query_map([], |row| {
            Ok(CampaignRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                status: row.get(2)?,
                created_at: row.get(3)?,
                draft_count: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut campaigns = Vec::new();
    for row in rows {
        campaigns.push(row.map_err(|e| e.to_string())?);
    }
    Ok(campaigns)
}

#[tauri::command]
fn list_drafts(app: tauri::AppHandle, payload: Option<CampaignFilterPayload>) -> Result<Vec<DraftRecord>, String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;
    let campaign_id = payload.and_then(|item| item.campaign_id);

    let sql = if campaign_id.is_some() {
        "
        SELECT d.id,
               d.campaign_id,
               COALESCE(cp.name, 'Round'),
               d.client_id,
               c.name,
               c.email,
               c.industry,
               COALESCE(c.company, ''),
               d.subject,
               d.body,
               d.status,
               COALESCE(t.name, 'Template'),
               d.created_at,
               COALESCE(d.generation_meta_json, '{}')
        FROM drafts d
        JOIN clients c ON c.id = d.client_id
        LEFT JOIN campaigns cp ON cp.id = d.campaign_id
        LEFT JOIN templates t ON t.id = cp.template_id
        WHERE d.campaign_id = ?1
        ORDER BY d.created_at DESC, d.id DESC
        "
    } else {
        "
        SELECT d.id,
               d.campaign_id,
               COALESCE(cp.name, 'Round'),
               d.client_id,
               c.name,
               c.email,
               c.industry,
               COALESCE(c.company, ''),
               d.subject,
               d.body,
               d.status,
               COALESCE(t.name, 'Template'),
               d.created_at,
               COALESCE(d.generation_meta_json, '{}')
        FROM drafts d
        JOIN clients c ON c.id = d.client_id
        LEFT JOIN campaigns cp ON cp.id = d.campaign_id
        LEFT JOIN templates t ON t.id = cp.template_id
        ORDER BY d.created_at DESC, d.id DESC
        "
    };

    let mut drafts = Vec::new();
    let mut statement = conn.prepare(sql).map_err(|e| e.to_string())?;
    if let Some(id) = campaign_id {
        let rows = statement
            .query_map([id], |row| {
                let meta_json: String = row.get(13)?;
                let (generation_mode, generation_label, needs_attention) = generation_summary(&meta_json);
                Ok(DraftRecord {
                    id: row.get(0)?,
                    campaign_id: row.get(1)?,
                    campaign_name: row.get(2)?,
                    client_id: row.get(3)?,
                    client_name: row.get(4)?,
                    client_email: row.get(5)?,
                    client_industry: row.get(6)?,
                    client_company: row.get(7)?,
                    subject: row.get(8)?,
                    body: row.get(9)?,
                    status: row.get(10)?,
                    template_name: row.get(11)?,
                    created_at: row.get(12)?,
                    generation_mode,
                    generation_label,
                    needs_attention,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            drafts.push(row.map_err(|e| e.to_string())?);
        }
    } else {
        let rows = statement
            .query_map([], |row| {
                let meta_json: String = row.get(13)?;
                let (generation_mode, generation_label, needs_attention) = generation_summary(&meta_json);
                Ok(DraftRecord {
                    id: row.get(0)?,
                    campaign_id: row.get(1)?,
                    campaign_name: row.get(2)?,
                    client_id: row.get(3)?,
                    client_name: row.get(4)?,
                    client_email: row.get(5)?,
                    client_industry: row.get(6)?,
                    client_company: row.get(7)?,
                    subject: row.get(8)?,
                    body: row.get(9)?,
                    status: row.get(10)?,
                    template_name: row.get(11)?,
                    created_at: row.get(12)?,
                    generation_mode,
                    generation_label,
                    needs_attention,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            drafts.push(row.map_err(|e| e.to_string())?);
        }
    }
    Ok(drafts)
}

#[tauri::command]
fn update_draft(app: tauri::AppHandle, payload: DraftUpdatePayload) -> Result<(), String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;

    let valid_status = ["review_required", "refine_requested", "approved", "sent"];
    if !valid_status.contains(&payload.status.as_str()) {
        return Err(
            "Invalid status. Use review_required, refine_requested, approved, or sent.".to_owned(),
        );
    }

    conn.execute(
        "
        UPDATE drafts
        SET subject = ?1,
            body = ?2,
            status = ?3
        WHERE id = ?4
    ",
        params![payload.subject, payload.body, payload.status, payload.draft_id],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn regenerate_draft(
    app: tauri::AppHandle,
    payload: DraftRegeneratePayload,
) -> Result<DraftRecord, String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;

    let settings = get_generation_settings(app.clone())?;

    let draft_row = conn
        .query_row(
            "
            SELECT d.id, d.client_id, d.campaign_id, d.generation_meta_json
            FROM drafts d
            WHERE d.id = ?1
            LIMIT 1
        ",
            [payload.draft_id],
            |row| {
                Ok((
                    row.get::<usize, i64>(0)?,
                    row.get::<usize, i64>(1)?,
                    row.get::<usize, i64>(2)?,
                    row.get::<usize, String>(3).unwrap_or_else(|_| "{}".to_owned()),
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Draft not found.".to_owned())?;

    let (draft_id, client_id, campaign_id, meta_json) = draft_row;
    let template_id_from_meta = serde_json::from_str::<serde_json::Value>(&meta_json)
        .ok()
        .and_then(|json| json.get("template_id").and_then(|v| v.as_i64()));

    let client = conn
        .query_row(
            "
            SELECT id, name, email, industry, COALESCE(company, ''), COALESCE(last_contacted_at, '')
            FROM clients WHERE id = ?1
        ",
            [client_id],
            |row| {
                Ok(ClientRow {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    email: row.get(2)?,
                    industry: row.get(3)?,
                    company: row.get(4)?,
                    last_contacted_at: row.get(5)?,
                })
            },
        )
        .map_err(|e| e.to_string())?;

    // Reload the campaign context so the regenerated draft stays on-brief.
    let campaign_context = {
        let (camp_name, filter_json): (String, String) = conn
            .query_row(
                "SELECT name, COALESCE(filter_json, '{}') FROM campaigns WHERE id = ?1",
                [campaign_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap_or_else(|_| (String::new(), "{}".to_owned()));

        let filter: serde_json::Value =
            serde_json::from_str(&filter_json).unwrap_or(serde_json::json!({}));
        let goal = filter.get("campaign_goal").and_then(|v| v.as_str()).unwrap_or("").to_owned();
        let cta  = filter.get("call_to_action").and_then(|v| v.as_str()).unwrap_or("").to_owned();
        let extra = filter.get("extra_context").and_then(|v| v.as_str()).unwrap_or("").to_owned();

        let mut ctx = build_campaign_context(&camp_name, &goal, &cta, &extra);
        let booking_url = get_setting_value(&conn, "booking_url")?.unwrap_or_default();
        if !booking_url.is_empty() {
            ctx = format!("{ctx}\nBooking link (include naturally as the tour scheduling CTA): {booking_url}");
        }
        ctx
    };

    let template = resolve_template_for_client(&conn, template_id_from_meta, &client.industry)?;
    let model = payload.model.unwrap_or(settings.model.clone());
    let kctx = load_knowledge_context(&conn, Some(campaign_id), Some(client_id));

    let (subject, body, meta) = generate_subject_and_body(
        &GenerationSettings {
            model: settings.model,
            default_system_prompt: settings.default_system_prompt,
            sender_name: settings.sender_name,
            sender_position: settings.sender_position,
            sender_company: settings.sender_company,
        },
        &template,
        &client,
        payload.instruction.as_deref(),
        Some(&campaign_context),
        Some(&model),
        Some(&kctx),
        false,
    );

    conn.execute(
        "
        UPDATE drafts
        SET subject = ?1,
            body = ?2,
            status = 'review_required',
            generation_meta_json = ?3
        WHERE id = ?4
    ",
        params![subject, body, meta, draft_id],
    )
    .map_err(|e| e.to_string())?;

    let updated = conn
        .query_row(
            "
            SELECT d.id,
                   d.campaign_id,
                   COALESCE(cp.name, 'Round'),
                   d.client_id,
                   c.name,
                   c.email,
                   c.industry,
                   COALESCE(c.company, ''),
                   d.subject,
                   d.body,
                   d.status,
                   COALESCE(t.name, 'Template'),
                   d.created_at,
                   COALESCE(d.generation_meta_json, '{}')
            FROM drafts d
            JOIN clients c ON c.id = d.client_id
            LEFT JOIN campaigns cp ON cp.id = d.campaign_id
            LEFT JOIN templates t ON t.id = cp.template_id
            WHERE d.id = ?1 AND d.campaign_id = ?2
            LIMIT 1
        ",
            params![draft_id, campaign_id],
            |row| {
                let meta_json: String = row.get(13)?;
                let (generation_mode, generation_label, needs_attention) = generation_summary(&meta_json);
                Ok(DraftRecord {
                    id: row.get(0)?,
                    campaign_id: row.get(1)?,
                    campaign_name: row.get(2)?,
                    client_id: row.get(3)?,
                    client_name: row.get(4)?,
                    client_email: row.get(5)?,
                    client_industry: row.get(6)?,
                    client_company: row.get(7)?,
                    subject: row.get(8)?,
                    body: row.get(9)?,
                    status: row.get(10)?,
                    template_name: row.get(11)?,
                    created_at: row.get(12)?,
                    generation_mode,
                    generation_label,
                    needs_attention,
                })
            },
        )
        .map_err(|e| e.to_string())?;

    Ok(updated)
}

#[tauri::command]
fn get_workflow_summary(
    app: tauri::AppHandle,
    payload: Option<CampaignFilterPayload>,
) -> Result<WorkflowSummary, String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;
    let campaign_id = payload.and_then(|item| item.campaign_id);

    let total_clients: i64 = conn
        .query_row("SELECT COUNT(1) FROM clients", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    let review_required: i64 = if let Some(id) = campaign_id {
        conn.query_row(
            "SELECT COUNT(1) FROM drafts WHERE campaign_id = ?1 AND (status = 'review_required' OR status = 'refine_requested')",
            [id],
            |row| row.get(0),
        )
    } else {
        conn.query_row(
            "SELECT COUNT(1) FROM drafts WHERE status = 'review_required' OR status = 'refine_requested'",
            [],
            |row| row.get(0),
        )
    }
    .map_err(|e| e.to_string())?;
    let approved: i64 = if let Some(id) = campaign_id {
        conn.query_row(
            "SELECT COUNT(1) FROM drafts WHERE campaign_id = ?1 AND status = 'approved'",
            [id],
            |row| row.get(0),
        )
    } else {
        conn.query_row("SELECT COUNT(1) FROM drafts WHERE status = 'approved'", [], |row| row.get(0))
    }
    .map_err(|e| e.to_string())?;
    let sent: i64 = if let Some(id) = campaign_id {
        conn.query_row(
            "
            SELECT COUNT(DISTINCT sh.draft_id)
            FROM send_history sh
            JOIN drafts d ON d.id = sh.draft_id
            WHERE sh.delivery_status = 'sent' AND d.campaign_id = ?1
            ",
            [id],
            |row| row.get(0),
        )
    } else {
        conn.query_row(
            "SELECT COUNT(DISTINCT draft_id) FROM send_history WHERE delivery_status = 'sent'",
            [],
            |row| row.get(0),
        )
    }
    .map_err(|e| e.to_string())?;
    let exported: i64 = if let Some(id) = campaign_id {
        conn.query_row(
            "
            SELECT COUNT(DISTINCT eh.draft_id)
            FROM export_history eh
            JOIN drafts d ON d.id = eh.draft_id
            WHERE d.campaign_id = ?1
            ",
            [id],
            |row| row.get(0),
        )
    } else {
        conn.query_row("SELECT COUNT(DISTINCT draft_id) FROM export_history", [], |row| row.get(0))
    }
    .map_err(|e| e.to_string())?;

    Ok(WorkflowSummary {
        total_clients,
        review_required,
        approved,
        sent,
        exported,
    })
}

#[tauri::command]
fn send_approved_drafts(
    app: tauri::AppHandle,
    payload: Option<serde_json::Value>,
) -> Result<SendResult, String> {
    let _ = (app, payload);
    Err("Sending is intentionally disabled until a real email provider is configured. Approved drafts remain safe in the review queue.".to_owned())
}

#[tauri::command]
fn mark_exported_drafts(
    app: tauri::AppHandle,
    payload: ExportDraftsPayload,
) -> Result<SendResult, String> {
    if payload.draft_ids.is_empty() {
        return Err("Choose at least one draft to export.".to_owned());
    }
    if payload.format.trim().is_empty() {
        return Err("Export format is required.".to_owned());
    }

    let mut conn = open_database(&app)?;
    ensure_schema(&conn)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let mut affected = 0usize;
    for draft_id in payload.draft_ids {
        let exists: Option<i64> = tx
            .query_row(
                "SELECT id FROM drafts WHERE id = ?1 LIMIT 1",
                [draft_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;

        if exists.is_none() {
            continue;
        }

        if let Some(campaign_id) = payload.campaign_id {
            let belongs: Option<i64> = tx
                .query_row(
                    "SELECT id FROM drafts WHERE id = ?1 AND campaign_id = ?2 LIMIT 1",
                    params![draft_id, campaign_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            if belongs.is_none() {
                continue;
            }
        }

        tx.execute(
            "
            INSERT INTO export_history (draft_id, format, file_name)
            VALUES (?1, ?2, ?3)
        ",
            params![draft_id, payload.format, payload.file_name],
        )
        .map_err(|e| e.to_string())?;
        affected += 1;
    }

    tx.commit().map_err(|e| e.to_string())?;

    Ok(SendResult {
        sent_count: affected,
    })
}

#[tauri::command]
fn list_history(
    app: tauri::AppHandle,
    payload: Option<CampaignFilterPayload>,
) -> Result<Vec<HistoryRecord>, String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;
    let campaign_id = payload.and_then(|item| item.campaign_id);

    let base_sql = if campaign_id.is_some() {
        "
        SELECT sh.id,
               sh.draft_id,
               c.name,
               c.email,
               'send',
               sh.provider || CASE
                 WHEN COALESCE(sh.provider_message_id, '') = '' THEN ''
                 ELSE ' | ' || sh.provider_message_id
               END,
               sh.sent_at,
               sh.delivery_status
        FROM send_history sh
        JOIN drafts d ON d.id = sh.draft_id
        JOIN clients c ON c.id = d.client_id
        WHERE d.campaign_id = ?1
        UNION ALL
        SELECT 1000000000 + eh.id,
               eh.draft_id,
               c.name,
               c.email,
               'export',
               eh.format || CASE
                 WHEN COALESCE(eh.file_name, '') = '' THEN ''
                 ELSE ' | ' || eh.file_name
               END,
               eh.exported_at,
               'completed'
        FROM export_history eh
        JOIN drafts d ON d.id = eh.draft_id
        JOIN clients c ON c.id = d.client_id
        WHERE d.campaign_id = ?1
        ORDER BY 7 DESC, 1 DESC
        "
    } else {
        "
        SELECT sh.id,
               sh.draft_id,
               c.name,
               c.email,
               'send',
               sh.provider || CASE
                 WHEN COALESCE(sh.provider_message_id, '') = '' THEN ''
                 ELSE ' | ' || sh.provider_message_id
               END,
               sh.sent_at,
               sh.delivery_status
        FROM send_history sh
        JOIN drafts d ON d.id = sh.draft_id
        JOIN clients c ON c.id = d.client_id
        UNION ALL
        SELECT 1000000000 + eh.id,
               eh.draft_id,
               c.name,
               c.email,
               'export',
               eh.format || CASE
                 WHEN COALESCE(eh.file_name, '') = '' THEN ''
                 ELSE ' | ' || eh.file_name
               END,
               eh.exported_at,
               'completed'
        FROM export_history eh
        JOIN drafts d ON d.id = eh.draft_id
        JOIN clients c ON c.id = d.client_id
        ORDER BY 7 DESC, 1 DESC
        "
    };

    let mut history = Vec::new();
    let mut statement = conn.prepare(base_sql).map_err(|e| e.to_string())?;
    if let Some(id) = campaign_id {
        let rows = statement
            .query_map([id], |row| {
                Ok(HistoryRecord {
                    id: row.get(0)?,
                    draft_id: row.get(1)?,
                    client_name: row.get(2)?,
                    client_email: row.get(3)?,
                    event_type: row.get(4)?,
                    detail: row.get(5)?,
                    happened_at: row.get(6)?,
                    status: row.get(7)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            history.push(row.map_err(|e| e.to_string())?);
        }
    } else {
        let rows = statement
            .query_map([], |row| {
                Ok(HistoryRecord {
                    id: row.get(0)?,
                    draft_id: row.get(1)?,
                    client_name: row.get(2)?,
                    client_email: row.get(3)?,
                    event_type: row.get(4)?,
                    detail: row.get(5)?,
                    happened_at: row.get(6)?,
                    status: row.get(7)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            history.push(row.map_err(|e| e.to_string())?);
        }
    }

    Ok(history)
}

#[tauri::command]
fn delete_draft(app: tauri::AppHandle, payload: DeleteDraftPayload) -> Result<DeleteResult, String> {
    let mut conn = open_database(&app)?;
    ensure_schema(&conn)?;

    let campaign_id: Option<i64> = conn
        .query_row(
            "SELECT campaign_id FROM drafts WHERE id = ?1 LIMIT 1",
            [payload.draft_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    let Some(campaign_id) = campaign_id else {
        return Ok(DeleteResult { deleted_count: 0 });
    };

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    delete_draft_related_records(&tx, payload.draft_id)?;
    let deleted = tx
        .execute("DELETE FROM drafts WHERE id = ?1", [payload.draft_id])
        .map_err(|e| e.to_string())?;
    cleanup_empty_campaign(&tx, campaign_id)?;
    tx.commit().map_err(|e| e.to_string())?;

    Ok(DeleteResult {
        deleted_count: deleted,
    })
}

#[tauri::command]
fn delete_campaign(app: tauri::AppHandle, payload: DeleteCampaignPayload) -> Result<DeleteResult, String> {
    let mut conn = open_database(&app)?;
    ensure_schema(&conn)?;

    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let mut draft_statement = tx
        .prepare("SELECT id FROM drafts WHERE campaign_id = ?1")
        .map_err(|e| e.to_string())?;
    let draft_ids = draft_statement
        .query_map([payload.campaign_id], |row| row.get::<usize, i64>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(draft_statement);

    for draft_id in &draft_ids {
        delete_draft_related_records(&tx, *draft_id)?;
    }

    tx.execute("DELETE FROM drafts WHERE campaign_id = ?1", [payload.campaign_id])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM generation_jobs WHERE campaign_id = ?1", [payload.campaign_id])
        .map_err(|e| e.to_string())?;
    let deleted = tx
        .execute("DELETE FROM campaigns WHERE id = ?1", [payload.campaign_id])
        .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;

    Ok(DeleteResult {
        deleted_count: deleted,
    })
}

#[tauri::command]
fn delete_client(app: tauri::AppHandle, payload: DeleteClientPayload) -> Result<DeleteResult, String> {
    let mut conn = open_database(&app)?;
    ensure_schema(&conn)?;

    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let mut draft_statement = tx
        .prepare("SELECT id, campaign_id FROM drafts WHERE client_id = ?1")
        .map_err(|e| e.to_string())?;
    let linked_drafts = draft_statement
        .query_map([payload.client_id], |row| {
            Ok((row.get::<usize, i64>(0)?, row.get::<usize, i64>(1)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(draft_statement);

    for (draft_id, _) in &linked_drafts {
        delete_draft_related_records(&tx, *draft_id)?;
    }

    let affected_campaigns = linked_drafts
        .iter()
        .map(|(_, campaign_id)| *campaign_id)
        .collect::<Vec<_>>();

    tx.execute("DELETE FROM drafts WHERE client_id = ?1", [payload.client_id])
        .map_err(|e| e.to_string())?;
    let deleted = tx
        .execute("DELETE FROM clients WHERE id = ?1", [payload.client_id])
        .map_err(|e| e.to_string())?;

    for campaign_id in affected_campaigns {
        cleanup_empty_campaign(&tx, campaign_id)?;
    }

    tx.commit().map_err(|e| e.to_string())?;

    Ok(DeleteResult {
        deleted_count: deleted,
    })
}

#[tauri::command]
fn reset_workspace_data(
    app: tauri::AppHandle,
    payload: ResetWorkspacePayload,
) -> Result<DeleteResult, String> {
    if !payload.clear_campaigns && !payload.clear_clients {
        return Err("Choose at least one reset action.".to_owned());
    }

    let mut conn = open_database(&app)?;
    ensure_schema(&conn)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut deleted_count = 0usize;

    if payload.clear_campaigns {
        let draft_count: i64 = tx
            .query_row("SELECT COUNT(1) FROM drafts", [], |row| row.get(0))
            .map_err(|e| e.to_string())?;

        tx.execute("DELETE FROM send_history", [])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM export_history", [])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM drafts", [])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM generation_jobs", [])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM campaigns", [])
            .map_err(|e| e.to_string())?;
        deleted_count += draft_count as usize;
    }

    if payload.clear_clients {
        let client_count: i64 = tx
            .query_row("SELECT COUNT(1) FROM clients", [], |row| row.get(0))
            .map_err(|e| e.to_string())?;

        tx.execute("DELETE FROM send_history", [])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM export_history", [])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM drafts", [])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM generation_jobs", [])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM campaigns", [])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM clients", [])
            .map_err(|e| e.to_string())?;
        deleted_count += client_count as usize;
    }

    tx.commit().map_err(|e| e.to_string())?;

    Ok(DeleteResult { deleted_count })
}

fn load_email_settings_internal(conn: &Connection) -> Result<EmailSettings, String> {
    let smtp_host = get_setting_value(conn, "smtp_host")?.unwrap_or_default();
    let smtp_port = get_setting_value(conn, "smtp_port")?
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(587);
    let smtp_user = get_setting_value(conn, "smtp_user")?.unwrap_or_default();
    let smtp_password = get_setting_value(conn, "smtp_password")?.unwrap_or_default();
    let smtp_from_name = get_setting_value(conn, "smtp_from_name")?.unwrap_or_default();
    let booking_url = get_setting_value(conn, "booking_url")?.unwrap_or_default();
    Ok(EmailSettings { smtp_host, smtp_port, smtp_user, smtp_password, smtp_from_name, booking_url })
}

fn build_smtp_transport(settings: &EmailSettings) -> Result<SmtpTransport, String> {
    if settings.smtp_host.is_empty() || settings.smtp_user.is_empty() {
        return Err("SMTP host and username are required. Configure them in Settings.".to_owned());
    }
    let creds = Credentials::new(settings.smtp_user.clone(), settings.smtp_password.clone());
    let transport = if settings.smtp_port == 465 {
        SmtpTransport::relay(&settings.smtp_host)
            .map_err(|e| format!("SMTP relay failed: {e}"))?
            .credentials(creds)
            .build()
    } else {
        SmtpTransport::starttls_relay(&settings.smtp_host)
            .map_err(|e| format!("SMTP STARTTLS failed: {e}"))?
            .port(settings.smtp_port)
            .credentials(creds)
            .build()
    };
    Ok(transport)
}

fn send_one_email(
    transport: &SmtpTransport,
    from_name: &str,
    from_email: &str,
    to_name: &str,
    to_email: &str,
    subject: &str,
    body: &str,
) -> Result<(), String> {
    let from_addr = format!("{from_name} <{from_email}>")
        .parse::<Mailbox>()
        .map_err(|e| format!("Invalid sender address: {e}"))?;
    let to_addr = format!("{to_name} <{to_email}>")
        .parse::<Mailbox>()
        .map_err(|e| format!("Invalid recipient address: {e}"))?;
    let email = Message::builder()
        .from(from_addr)
        .to(to_addr)
        .subject(subject)
        .header(ContentType::TEXT_PLAIN)
        .body(body.to_owned())
        .map_err(|e| format!("Could not build email: {e}"))?;
    transport.send(&email).map_err(|e| format!("Send failed: {e}"))?;
    Ok(())
}

fn body_with_booking_link(body: &str, booking_url: &str) -> String {
    if booking_url.is_empty() || body.contains(booking_url) {
        return body.to_owned();
    }
    format!("{body}\n\nReady to schedule a tour? Book your time here: {booking_url}")
}

fn trigger_send_campaign(app: &tauri::AppHandle, campaign_id: i64) -> Result<usize, String> {
    let conn = open_database(app)?;
    ensure_schema(&conn)?;

    let email_settings = load_email_settings_internal(&conn)?;
    if email_settings.smtp_host.is_empty() {
        return Err("Configure SMTP settings in the Settings tab before sending.".to_owned());
    }

    let gen_settings = get_generation_settings(app.clone())?;
    let from_name = if !email_settings.smtp_from_name.is_empty() {
        email_settings.smtp_from_name.clone()
    } else {
        gen_settings.sender_name.clone()
    };

    let mut stmt = conn
        .prepare(
            "SELECT d.id, d.subject, d.body, c.name, c.email
             FROM drafts d
             JOIN clients c ON c.id = d.client_id
             WHERE d.campaign_id = ?1 AND d.status = 'approved' AND d.sent_at IS NULL
             ORDER BY d.id",
        )
        .map_err(|e| e.to_string())?;

    let draft_rows: Vec<(i64, String, String, String, String)> = stmt
        .query_map([campaign_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    if draft_rows.is_empty() {
        return Err(
            "No approved unsent drafts found for this round. Approve some drafts first.".to_owned(),
        );
    }

    let total_count = draft_rows.len();
    let app_handle = app.clone();

    thread::spawn(move || {
        let transport = match build_smtp_transport(&email_settings) {
            Ok(t) => t,
            Err(e) => {
                let _ = app_handle.emit(
                    "send-progress",
                    SendProgressEvent {
                        draft_id: None,
                        client_name: None,
                        status: "error".to_owned(),
                        error: Some(e),
                        sent_count: 0,
                        failed_count: total_count,
                        total_count,
                        done: true,
                    },
                );
                return;
            }
        };

        let conn = match open_database(&app_handle) {
            Ok(c) => c,
            Err(_) => return,
        };
        let _ = ensure_schema(&conn);

        let mut sent_count = 0usize;
        let mut failed_count = 0usize;

        for (draft_id, subject, body, client_name, client_email) in &draft_rows {
            let final_body = body_with_booking_link(body, &email_settings.booking_url);

            let _ = app_handle.emit(
                "send-progress",
                SendProgressEvent {
                    draft_id: Some(*draft_id),
                    client_name: Some(client_name.clone()),
                    status: "sending".to_owned(),
                    error: None,
                    sent_count,
                    failed_count,
                    total_count,
                    done: false,
                },
            );

            match send_one_email(
                &transport,
                &from_name,
                &email_settings.smtp_user,
                client_name,
                client_email,
                subject,
                &final_body,
            ) {
                Ok(_) => {
                    sent_count += 1;
                    let _ = conn.execute(
                        "UPDATE drafts SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE id = ?1",
                        [draft_id],
                    );
                    let _ = conn.execute(
                        "INSERT INTO send_history (draft_id, provider, delivery_status) VALUES (?1, 'smtp', 'sent')",
                        [draft_id],
                    );
                    let _ = app_handle.emit(
                        "send-progress",
                        SendProgressEvent {
                            draft_id: Some(*draft_id),
                            client_name: Some(client_name.clone()),
                            status: "sent".to_owned(),
                            error: None,
                            sent_count,
                            failed_count,
                            total_count,
                            done: false,
                        },
                    );
                }
                Err(e) => {
                    failed_count += 1;
                    let _ = conn.execute(
                        "INSERT INTO send_history (draft_id, provider, delivery_status) VALUES (?1, 'smtp', 'failed')",
                        [draft_id],
                    );
                    let _ = app_handle.emit(
                        "send-progress",
                        SendProgressEvent {
                            draft_id: Some(*draft_id),
                            client_name: Some(client_name.clone()),
                            status: "failed".to_owned(),
                            error: Some(e),
                            sent_count,
                            failed_count,
                            total_count,
                            done: false,
                        },
                    );
                }
            }
        }

        let _ = app_handle.emit(
            "send-progress",
            SendProgressEvent {
                draft_id: None,
                client_name: None,
                status: "done".to_owned(),
                error: None,
                sent_count,
                failed_count,
                total_count,
                done: true,
            },
        );
    });

    Ok(total_count)
}

fn check_scheduled_sends(app: &tauri::AppHandle) {
    let conn = match open_database(app) {
        Ok(c) => c,
        Err(_) => return,
    };
    if ensure_schema(&conn).is_err() {
        return;
    }

    let mut stmt = match conn.prepare(
        "SELECT id FROM campaigns
         WHERE scheduled_at IS NOT NULL
           AND scheduled_at <= datetime('now')
         LIMIT 10",
    ) {
        Ok(s) => s,
        Err(_) => return,
    };

    let pending: Vec<i64> = match stmt.query_map([], |row| row.get(0)) {
        Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
        Err(_) => return,
    };

    for campaign_id in pending {
        let _ = conn.execute(
            "UPDATE campaigns SET scheduled_at = NULL WHERE id = ?1",
            [campaign_id],
        );
        let _ = trigger_send_campaign(app, campaign_id);
    }
}

#[tauri::command]
fn get_email_settings(app: tauri::AppHandle) -> Result<EmailSettings, String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;
    load_email_settings_internal(&conn)
}

#[tauri::command]
fn set_email_settings(app: tauri::AppHandle, payload: EmailSettingsPayload) -> Result<(), String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;
    set_setting_value(&conn, "smtp_host", &payload.smtp_host)?;
    set_setting_value(&conn, "smtp_port", &payload.smtp_port.to_string())?;
    set_setting_value(&conn, "smtp_user", &payload.smtp_user)?;
    set_setting_value(&conn, "smtp_password", &payload.smtp_password)?;
    set_setting_value(&conn, "smtp_from_name", &payload.smtp_from_name)?;
    set_setting_value(&conn, "booking_url", &payload.booking_url)?;
    Ok(())
}

#[tauri::command]
fn test_smtp_connection(app: tauri::AppHandle) -> Result<String, String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;
    let email_settings = load_email_settings_internal(&conn)?;
    let gen_settings = get_generation_settings(app)?;
    let from_name = if !email_settings.smtp_from_name.is_empty() {
        email_settings.smtp_from_name.clone()
    } else {
        gen_settings.sender_name.clone()
    };
    let transport = build_smtp_transport(&email_settings)?;
    send_one_email(
        &transport,
        &from_name,
        &email_settings.smtp_user,
        &gen_settings.sender_name,
        &email_settings.smtp_user,
        "Executive Workspace — Connection Test",
        "Your email delivery is working correctly.\n\nThis test was sent from the Executive Workspace app to confirm your SMTP settings are configured properly.",
    )?;
    Ok("Test email sent. Check your inbox to confirm delivery.".to_owned())
}

#[tauri::command]
fn start_send_campaign_drafts(
    app: tauri::AppHandle,
    payload: SendCampaignPayload,
) -> Result<SendCampaignResult, String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;

    let approved_count: i64 = conn
        .query_row(
            "SELECT COUNT(1) FROM drafts WHERE campaign_id = ?1 AND status = 'approved' AND sent_at IS NULL",
            [payload.campaign_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    if approved_count == 0 {
        return Err(
            "No approved unsent drafts found for this round. Approve some drafts first.".to_owned(),
        );
    }

    let total = trigger_send_campaign(&app, payload.campaign_id)?;
    Ok(SendCampaignResult {
        sent_count: 0,
        failed_count: 0,
        approved_count: total,
    })
}

#[tauri::command]
fn schedule_campaign_send(
    app: tauri::AppHandle,
    payload: ScheduleCampaignPayload,
) -> Result<(), String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;
    conn.execute(
        "UPDATE campaigns SET scheduled_at = ?1 WHERE id = ?2",
        params![payload.scheduled_at, payload.campaign_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_campaign_send_status(
    app: tauri::AppHandle,
    payload: SendCampaignPayload,
) -> Result<CampaignSendStatus, String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;

    conn.query_row(
        "SELECT cp.id, cp.name, COALESCE(cp.scheduled_at, ''),
                COUNT(CASE WHEN d.status = 'approved' AND d.sent_at IS NULL THEN 1 END),
                COUNT(CASE WHEN d.status = 'sent' THEN 1 END)
         FROM campaigns cp
         LEFT JOIN drafts d ON d.campaign_id = cp.id
         WHERE cp.id = ?1
         GROUP BY cp.id, cp.name, cp.scheduled_at",
        [payload.campaign_id],
        |row| {
            let scheduled_at_raw: String = row.get(2)?;
            Ok(CampaignSendStatus {
                campaign_id: row.get(0)?,
                campaign_name: row.get(1)?,
                scheduled_at: if scheduled_at_raw.is_empty() {
                    None
                } else {
                    Some(scheduled_at_raw)
                },
                approved_count: row.get(3)?,
                sent_count: row.get(4)?,
            })
        },
    )
    .map_err(|e| e.to_string())
}

// ── Knowledge documents ───────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
struct KnowledgeDocument {
    id: i64,
    name: String,
    doc_type: String,
    campaign_id: Option<i64>,
    contact_id: Option<i64>,
    content: String,
    created_at: String,
}

#[derive(Deserialize)]
struct KnowledgeDocPayload {
    name: String,
    doc_type: String,
    campaign_id: Option<i64>,
    contact_id: Option<i64>,
    content: String,
}

fn row_to_knowledge_doc(row: &rusqlite::Row) -> rusqlite::Result<KnowledgeDocument> {
    Ok(KnowledgeDocument {
        id: row.get(0)?,
        name: row.get(1)?,
        doc_type: row.get(2)?,
        campaign_id: row.get(3)?,
        contact_id: row.get(4)?,
        content: row.get(5)?,
        created_at: row.get(6)?,
    })
}

#[tauri::command]
fn list_knowledge_docs(
    app: tauri::AppHandle,
    doc_type: Option<String>,
) -> Result<Vec<KnowledgeDocument>, String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, name, doc_type, campaign_id, contact_id, content, created_at
             FROM knowledge_documents ORDER BY doc_type, created_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let all_docs: Vec<KnowledgeDocument> = stmt
        .query_map([], |row| row_to_knowledge_doc(row))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    let docs = if let Some(ref dt) = doc_type {
        all_docs.into_iter().filter(|d| &d.doc_type == dt).collect()
    } else {
        all_docs
    };
    Ok(docs)
}

#[tauri::command]
fn save_knowledge_doc(
    app: tauri::AppHandle,
    payload: KnowledgeDocPayload,
) -> Result<KnowledgeDocument, String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;
    conn.execute(
        "INSERT INTO knowledge_documents (name, doc_type, campaign_id, contact_id, content)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            payload.name,
            payload.doc_type,
            payload.campaign_id,
            payload.contact_id,
            payload.content,
        ],
    )
    .map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();
    conn.query_row(
        "SELECT id, name, doc_type, campaign_id, contact_id, content, created_at
         FROM knowledge_documents WHERE id = ?1",
        [id],
        |row| row_to_knowledge_doc(row),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn update_knowledge_doc_content(
    app: tauri::AppHandle,
    id: i64,
    content: String,
) -> Result<(), String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;
    conn.execute(
        "UPDATE knowledge_documents SET content = ?1 WHERE id = ?2",
        params![content, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn delete_knowledge_doc(app: tauri::AppHandle, id: i64) -> Result<(), String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;
    conn.execute("DELETE FROM knowledge_documents WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn load_knowledge_context(
    conn: &Connection,
    campaign_id: Option<i64>,
    contact_id: Option<i64>,
) -> String {
    let mut sections: Vec<String> = Vec::new();

    // Company profile docs (always included)
    let company_docs: Vec<String> = conn
        .prepare(
            "SELECT content FROM knowledge_documents WHERE doc_type = 'company' ORDER BY created_at DESC LIMIT 3",
        )
        .and_then(|mut s| {
            s.query_map([], |r| r.get::<_, String>(0))
                .map(|rows| rows.filter_map(|r| r.ok()).collect())
        })
        .unwrap_or_default();

    if !company_docs.is_empty() {
        sections.push(format!(
            "COMPANY PROFILE:\n{}",
            company_docs.join("\n\n")
        ));
    }

    // Campaign-specific docs
    if let Some(cid) = campaign_id {
        let campaign_docs: Vec<String> = conn
            .prepare(
                "SELECT content FROM knowledge_documents WHERE doc_type = 'campaign' AND campaign_id = ?1 ORDER BY created_at DESC LIMIT 3",
            )
            .and_then(|mut s| {
                s.query_map([cid], |r| r.get::<_, String>(0))
                    .map(|rows| rows.filter_map(|r| r.ok()).collect())
            })
            .unwrap_or_default();

        if !campaign_docs.is_empty() {
            sections.push(format!(
                "CAMPAIGN BRIEF:\n{}",
                campaign_docs.join("\n\n")
            ));
        }
    }

    // Per-contact docs
    if let Some(cid) = contact_id {
        let contact_docs: Vec<String> = conn
            .prepare(
                "SELECT content FROM knowledge_documents WHERE doc_type = 'contact' AND contact_id = ?1 ORDER BY created_at DESC LIMIT 2",
            )
            .and_then(|mut s| {
                s.query_map([cid], |r| r.get::<_, String>(0))
                    .map(|rows| rows.filter_map(|r| r.ok()).collect())
            })
            .unwrap_or_default();

        if !contact_docs.is_empty() {
            sections.push(format!(
                "RECIPIENT RESEARCH:\n{}",
                contact_docs.join("\n\n")
            ));
        }
    }

    sections.join("\n\n---\n\n")
}

// ── Agent pipeline helper ─────────────────────────────────────────────────

fn run_planner_step(
    model: &str,
    campaign_context: &str,
    knowledge_context: &str,
    client: &ClientRow,
    settings: &GenerationSettings,
) -> Result<String, String> {
    let knowledge_section = if knowledge_context.trim().is_empty() {
        String::new()
    } else {
        format!("\n\nKnowledge base:\n{knowledge_context}")
    };

    let prompt = format!(
        "You are a senior communications strategist advising {sender_name}, {sender_position} at {sender_company}.\n\
         Plan a single outbound email to the recipient below. Output ONLY the plan, no email text yet.\n\
         {knowledge_section}\n\
         Campaign brief:\n{campaign_context}\n\
         Recipient: {name} at {company} ({industry})\n\n\
         Output this exact structure:\n\
         ANGLE: [one sentence — what makes this relevant to them specifically]\n\
         KEY_POINTS: [2-3 bullets of what to mention]\n\
         CTA: [exact call to action phrasing]\n\
         TONE: [one adjective — e.g. warm, direct, peer-to-peer]",
        sender_name = settings.sender_name,
        sender_position = settings.sender_position,
        sender_company = settings.sender_company,
        name = client.name,
        company = client.company,
        industry = client.industry,
    );

    call_ollama_generate(model, &prompt)
}

fn run_writer_step(
    model: &str,
    plan: &str,
    campaign_context: &str,
    knowledge_context: &str,
    template: &TemplateRow,
    client: &ClientRow,
    settings: &GenerationSettings,
    instruction: Option<&str>,
) -> (String, String) {
    let knowledge_section = if knowledge_context.trim().is_empty() {
        String::new()
    } else {
        format!("\n\nKnowledge base:\n{knowledge_context}")
    };

    let system_prompt = if template.system_prompt.trim().is_empty() {
        settings.default_system_prompt.clone()
    } else {
        template.system_prompt.clone()
    };

    let prompt = format!(
        "{system_prompt}\n\n\
         Write one polished outbound business email based on the plan below.\n\n\
         RULES:\n\
         - Never mention the internal round name from the campaign brief.\n\
         - Do not echo plan labels (ANGLE, KEY_POINTS, etc.) into the email.\n\
         - Do not use placeholders or brackets.\n\
         - Keep it concise — under 200 words.\n\n\
         Output format:\nSubject: <subject>\n<email body starting with greeting>\n\n\
         Strategic plan:\n{plan}\n\n\
         Campaign brief:\n{campaign_context}{knowledge_section}\n\n\
         Sender: {sender_name}, {sender_position}, {sender_company}\n\
         Recipient: {name}, {company} ({industry})\n\
         Tone: {tone}\n\
         Extra instruction: {instruction}",
        sender_name = settings.sender_name,
        sender_position = settings.sender_position,
        sender_company = settings.sender_company,
        name = client.name,
        company = client.company,
        industry = client.industry,
        tone = template.tone,
        instruction = instruction.unwrap_or("none"),
    );

    match call_ollama_generate(model, &prompt) {
        Ok(text) => {
            if let Some(pair) = parse_generated_email(&text) {
                pair
            } else {
                // Return raw text as body if parsing fails
                ("Follow-up".to_owned(), text)
            }
        }
        Err(_) => (
            format!("Opportunity for {}", client.company),
            format!(
                "Hi {},\n\nI wanted to reach out about a relevant opportunity for {}.\n\nBest,\n{}\n{}\n{}",
                client.name,
                client.company,
                settings.sender_name,
                settings.sender_position,
                settings.sender_company
            ),
        ),
    }
}

// ── Update client notes ───────────────────────────────────────────────────

#[derive(Deserialize)]
struct UpdateClientNotesPayload {
    id: i64,
    notes: String,
}

#[tauri::command]
fn update_client_notes(
    app: tauri::AppHandle,
    payload: UpdateClientNotesPayload,
) -> Result<(), String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;
    conn.execute(
        "UPDATE clients SET notes = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2",
        params![payload.notes, payload.id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Tasks ─────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
struct Task {
    id: i64,
    title: String,
    description: Option<String>,
    status: String,
    priority: String,
    due_date: Option<String>,
    source_type: Option<String>,
    source_id: Option<i64>,
    created_at: String,
    updated_at: String,
}

#[derive(Deserialize)]
struct TaskPayload {
    title: String,
    description: Option<String>,
    status: Option<String>,
    priority: Option<String>,
    due_date: Option<String>,
    source_type: Option<String>,
    source_id: Option<i64>,
}

#[derive(Deserialize)]
struct TaskUpdatePayload {
    id: i64,
    title: Option<String>,
    description: Option<String>,
    status: Option<String>,
    priority: Option<String>,
    due_date: Option<String>,
}

#[tauri::command]
fn list_tasks(app: tauri::AppHandle) -> Result<Vec<Task>, String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, title, description, status, priority, due_date,
                    source_type, source_id, created_at, updated_at
             FROM tasks
             ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
                      CASE status WHEN 'todo' THEN 1 WHEN 'in_progress' THEN 2 ELSE 3 END,
                      created_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let tasks = stmt
        .query_map([], |row| {
            Ok(Task {
                id: row.get(0)?,
                title: row.get(1)?,
                description: row.get(2)?,
                status: row.get(3)?,
                priority: row.get(4)?,
                due_date: row.get(5)?,
                source_type: row.get(6)?,
                source_id: row.get(7)?,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(tasks)
}

#[tauri::command]
fn create_task(app: tauri::AppHandle, payload: TaskPayload) -> Result<Task, String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;
    let status = payload.status.unwrap_or_else(|| "todo".to_owned());
    let priority = payload.priority.unwrap_or_else(|| "medium".to_owned());
    conn.execute(
        "INSERT INTO tasks (title, description, status, priority, due_date, source_type, source_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            payload.title,
            payload.description,
            status,
            priority,
            payload.due_date,
            payload.source_type,
            payload.source_id,
        ],
    )
    .map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();
    conn.query_row(
        "SELECT id, title, description, status, priority, due_date,
                source_type, source_id, created_at, updated_at
         FROM tasks WHERE id = ?1",
        [id],
        |row| {
            Ok(Task {
                id: row.get(0)?,
                title: row.get(1)?,
                description: row.get(2)?,
                status: row.get(3)?,
                priority: row.get(4)?,
                due_date: row.get(5)?,
                source_type: row.get(6)?,
                source_id: row.get(7)?,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            })
        },
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn update_task(app: tauri::AppHandle, payload: TaskUpdatePayload) -> Result<Task, String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;
    if let Some(title) = &payload.title {
        conn.execute("UPDATE tasks SET title = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2", params![title, payload.id]).map_err(|e| e.to_string())?;
    }
    if let Some(description) = &payload.description {
        conn.execute("UPDATE tasks SET description = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2", params![description, payload.id]).map_err(|e| e.to_string())?;
    }
    if let Some(status) = &payload.status {
        conn.execute("UPDATE tasks SET status = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2", params![status, payload.id]).map_err(|e| e.to_string())?;
    }
    if let Some(priority) = &payload.priority {
        conn.execute("UPDATE tasks SET priority = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2", params![priority, payload.id]).map_err(|e| e.to_string())?;
    }
    if let Some(due_date) = &payload.due_date {
        let val: Option<&str> = if due_date.is_empty() { None } else { Some(due_date.as_str()) };
        conn.execute("UPDATE tasks SET due_date = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2", params![val, payload.id]).map_err(|e| e.to_string())?;
    }
    conn.query_row(
        "SELECT id, title, description, status, priority, due_date,
                source_type, source_id, created_at, updated_at
         FROM tasks WHERE id = ?1",
        [payload.id],
        |row| {
            Ok(Task {
                id: row.get(0)?,
                title: row.get(1)?,
                description: row.get(2)?,
                status: row.get(3)?,
                priority: row.get(4)?,
                due_date: row.get(5)?,
                source_type: row.get(6)?,
                source_id: row.get(7)?,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            })
        },
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_task(app: tauri::AppHandle, id: i64) -> Result<(), String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;
    conn.execute("DELETE FROM tasks WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Meetings ──────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
struct Meeting {
    id: i64,
    title: String,
    meeting_date: Option<String>,
    attendees: Option<String>,
    raw_notes: Option<String>,
    summary: Option<String>,
    action_items_json: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Deserialize)]
struct MeetingPayload {
    title: String,
    meeting_date: Option<String>,
    attendees: Option<String>,
    raw_notes: Option<String>,
}

#[derive(Deserialize)]
struct MeetingUpdatePayload {
    id: i64,
    title: Option<String>,
    meeting_date: Option<String>,
    attendees: Option<String>,
    raw_notes: Option<String>,
    summary: Option<String>,
    action_items_json: Option<String>,
}

#[derive(Serialize)]
struct MeetingSummaryResult {
    id: i64,
    summary: String,
    action_items_json: String,
}

fn row_to_meeting(row: &rusqlite::Row) -> rusqlite::Result<Meeting> {
    Ok(Meeting {
        id: row.get(0)?,
        title: row.get(1)?,
        meeting_date: row.get(2)?,
        attendees: row.get(3)?,
        raw_notes: row.get(4)?,
        summary: row.get(5)?,
        action_items_json: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

#[tauri::command]
fn list_meetings(app: tauri::AppHandle) -> Result<Vec<Meeting>, String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, title, meeting_date, attendees, raw_notes, summary,
                    action_items_json, created_at, updated_at
             FROM meetings ORDER BY meeting_date DESC, created_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let meetings = stmt
        .query_map([], |row| row_to_meeting(row))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(meetings)
}

#[tauri::command]
fn create_meeting(app: tauri::AppHandle, payload: MeetingPayload) -> Result<Meeting, String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;
    conn.execute(
        "INSERT INTO meetings (title, meeting_date, attendees, raw_notes)
         VALUES (?1, ?2, ?3, ?4)",
        params![
            payload.title,
            payload.meeting_date,
            payload.attendees,
            payload.raw_notes,
        ],
    )
    .map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();
    conn.query_row(
        "SELECT id, title, meeting_date, attendees, raw_notes, summary,
                action_items_json, created_at, updated_at
         FROM meetings WHERE id = ?1",
        [id],
        |row| row_to_meeting(row),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn update_meeting(app: tauri::AppHandle, payload: MeetingUpdatePayload) -> Result<Meeting, String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;
    if let Some(v) = &payload.title {
        conn.execute("UPDATE meetings SET title = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2", params![v, payload.id]).map_err(|e| e.to_string())?;
    }
    if let Some(v) = &payload.meeting_date {
        let val: Option<&str> = if v.is_empty() { None } else { Some(v.as_str()) };
        conn.execute("UPDATE meetings SET meeting_date = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2", params![val, payload.id]).map_err(|e| e.to_string())?;
    }
    if let Some(v) = &payload.attendees {
        conn.execute("UPDATE meetings SET attendees = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2", params![v, payload.id]).map_err(|e| e.to_string())?;
    }
    if let Some(v) = &payload.raw_notes {
        conn.execute("UPDATE meetings SET raw_notes = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2", params![v, payload.id]).map_err(|e| e.to_string())?;
    }
    if let Some(v) = &payload.summary {
        conn.execute("UPDATE meetings SET summary = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2", params![v, payload.id]).map_err(|e| e.to_string())?;
    }
    if let Some(v) = &payload.action_items_json {
        conn.execute("UPDATE meetings SET action_items_json = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2", params![v, payload.id]).map_err(|e| e.to_string())?;
    }
    conn.query_row(
        "SELECT id, title, meeting_date, attendees, raw_notes, summary,
                action_items_json, created_at, updated_at
         FROM meetings WHERE id = ?1",
        [payload.id],
        |row| row_to_meeting(row),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_meeting(app: tauri::AppHandle, id: i64) -> Result<(), String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;
    conn.execute("DELETE FROM meetings WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn ai_summarize_meeting(
    app: tauri::AppHandle,
    id: i64,
    model: String,
) -> Result<MeetingSummaryResult, String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;
    let raw_notes: String = conn
        .query_row(
            "SELECT COALESCE(raw_notes, '') FROM meetings WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    if raw_notes.trim().is_empty() {
        return Err("No notes to summarize. Add meeting notes first.".to_owned());
    }

    let prompt = format!(
        "You are an executive assistant. Analyze the following meeting notes and produce a structured response.\n\n\
         MEETING NOTES:\n{raw_notes}\n\n\
         Respond with EXACTLY this format (no markdown, no extra text):\n\
         SUMMARY: [2-3 sentence summary of what was discussed and decided]\n\
         ACTION_ITEMS:\n- [action item 1]\n- [action item 2]\n- [action item N]\n\n\
         Extract only concrete next steps with clear ownership or deadlines if mentioned."
    );

    let raw_response = call_ollama_generate(&model, &prompt)?;

    let summary = raw_response
        .lines()
        .find(|l| l.starts_with("SUMMARY:"))
        .map(|l| l.trim_start_matches("SUMMARY:").trim().to_owned())
        .unwrap_or_else(|| raw_response.lines().next().unwrap_or("").to_owned());

    let action_items: Vec<String> = raw_response
        .lines()
        .skip_while(|l| !l.starts_with("ACTION_ITEMS:"))
        .skip(1)
        .filter(|l| l.trim_start().starts_with('-'))
        .map(|l| l.trim_start_matches('-').trim().to_owned())
        .filter(|l| !l.is_empty())
        .collect();

    let action_items_json =
        serde_json::to_string(&action_items).unwrap_or_else(|_| "[]".to_owned());

    conn.execute(
        "UPDATE meetings SET summary = ?1, action_items_json = ?2, updated_at = CURRENT_TIMESTAMP WHERE id = ?3",
        params![summary, action_items_json, id],
    )
    .map_err(|e| e.to_string())?;

    Ok(MeetingSummaryResult {
        id,
        summary,
        action_items_json,
    })
}

// ── Pipeline / Deals ──────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
struct Deal {
    id: i64,
    title: String,
    company: Option<String>,
    contact_name: Option<String>,
    contact_email: Option<String>,
    value_text: Option<String>,
    stage: String,
    notes: Option<String>,
    next_action: Option<String>,
    next_action_date: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Deserialize)]
struct DealPayload {
    title: String,
    company: Option<String>,
    contact_name: Option<String>,
    contact_email: Option<String>,
    value_text: Option<String>,
    stage: Option<String>,
    notes: Option<String>,
    next_action: Option<String>,
    next_action_date: Option<String>,
}

#[derive(Deserialize)]
struct DealUpdatePayload {
    id: i64,
    title: Option<String>,
    company: Option<String>,
    contact_name: Option<String>,
    contact_email: Option<String>,
    value_text: Option<String>,
    stage: Option<String>,
    notes: Option<String>,
    next_action: Option<String>,
    next_action_date: Option<String>,
}

fn row_to_deal(row: &rusqlite::Row) -> rusqlite::Result<Deal> {
    Ok(Deal {
        id: row.get(0)?,
        title: row.get(1)?,
        company: row.get(2)?,
        contact_name: row.get(3)?,
        contact_email: row.get(4)?,
        value_text: row.get(5)?,
        stage: row.get(6)?,
        notes: row.get(7)?,
        next_action: row.get(8)?,
        next_action_date: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

#[tauri::command]
fn list_deals(app: tauri::AppHandle) -> Result<Vec<Deal>, String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, title, company, contact_name, contact_email, value_text,
                    stage, notes, next_action, next_action_date, created_at, updated_at
             FROM deals
             ORDER BY CASE stage
               WHEN 'lead' THEN 1 WHEN 'qualified' THEN 2 WHEN 'proposal' THEN 3
               WHEN 'negotiation' THEN 4 WHEN 'won' THEN 5 WHEN 'lost' THEN 6 ELSE 7
             END, updated_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let deals = stmt
        .query_map([], |row| row_to_deal(row))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(deals)
}

#[tauri::command]
fn create_deal(app: tauri::AppHandle, payload: DealPayload) -> Result<Deal, String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;
    let stage = payload.stage.unwrap_or_else(|| "lead".to_owned());
    conn.execute(
        "INSERT INTO deals (title, company, contact_name, contact_email, value_text,
                            stage, notes, next_action, next_action_date)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            payload.title,
            payload.company,
            payload.contact_name,
            payload.contact_email,
            payload.value_text,
            stage,
            payload.notes,
            payload.next_action,
            payload.next_action_date,
        ],
    )
    .map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();
    conn.query_row(
        "SELECT id, title, company, contact_name, contact_email, value_text,
                stage, notes, next_action, next_action_date, created_at, updated_at
         FROM deals WHERE id = ?1",
        [id],
        |row| row_to_deal(row),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn update_deal(app: tauri::AppHandle, payload: DealUpdatePayload) -> Result<Deal, String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;
    macro_rules! set_field {
        ($col:literal, $val:expr) => {
            if let Some(v) = $val {
                conn.execute(
                    concat!("UPDATE deals SET ", $col, " = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2"),
                    params![v, payload.id],
                ).map_err(|e| e.to_string())?;
            }
        };
    }
    set_field!("title", &payload.title);
    set_field!("company", &payload.company);
    set_field!("contact_name", &payload.contact_name);
    set_field!("contact_email", &payload.contact_email);
    set_field!("value_text", &payload.value_text);
    set_field!("stage", &payload.stage);
    set_field!("notes", &payload.notes);
    set_field!("next_action", &payload.next_action);
    set_field!("next_action_date", &payload.next_action_date);
    conn.query_row(
        "SELECT id, title, company, contact_name, contact_email, value_text,
                stage, notes, next_action, next_action_date, created_at, updated_at
         FROM deals WHERE id = ?1",
        [payload.id],
        |row| row_to_deal(row),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_deal(app: tauri::AppHandle, id: i64) -> Result<(), String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;
    conn.execute("DELETE FROM deals WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Documents ─────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
struct Document {
    id: i64,
    title: String,
    doc_type: String,
    brief: Option<String>,
    content: Option<String>,
    status: String,
    created_at: String,
    updated_at: String,
}

#[derive(Deserialize)]
struct DocumentPayload {
    title: String,
    doc_type: Option<String>,
    brief: Option<String>,
    content: Option<String>,
}

#[derive(Deserialize)]
struct DocumentUpdatePayload {
    id: i64,
    title: Option<String>,
    doc_type: Option<String>,
    brief: Option<String>,
    content: Option<String>,
    status: Option<String>,
}

fn row_to_document(row: &rusqlite::Row) -> rusqlite::Result<Document> {
    Ok(Document {
        id: row.get(0)?,
        title: row.get(1)?,
        doc_type: row.get(2)?,
        brief: row.get(3)?,
        content: row.get(4)?,
        status: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

#[tauri::command]
fn list_documents(app: tauri::AppHandle) -> Result<Vec<Document>, String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, title, doc_type, brief, content, status, created_at, updated_at
             FROM documents ORDER BY updated_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let docs = stmt
        .query_map([], |row| row_to_document(row))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(docs)
}

#[tauri::command]
fn create_document(app: tauri::AppHandle, payload: DocumentPayload) -> Result<Document, String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;
    let doc_type = payload.doc_type.unwrap_or_else(|| "proposal".to_owned());
    conn.execute(
        "INSERT INTO documents (title, doc_type, brief, content) VALUES (?1, ?2, ?3, ?4)",
        params![payload.title, doc_type, payload.brief, payload.content],
    )
    .map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();
    conn.query_row(
        "SELECT id, title, doc_type, brief, content, status, created_at, updated_at
         FROM documents WHERE id = ?1",
        [id],
        |row| row_to_document(row),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn update_document(
    app: tauri::AppHandle,
    payload: DocumentUpdatePayload,
) -> Result<Document, String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;
    macro_rules! set_doc_field {
        ($col:literal, $val:expr) => {
            if let Some(v) = $val {
                conn.execute(
                    concat!("UPDATE documents SET ", $col, " = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2"),
                    params![v, payload.id],
                ).map_err(|e| e.to_string())?;
            }
        };
    }
    set_doc_field!("title", &payload.title);
    set_doc_field!("doc_type", &payload.doc_type);
    set_doc_field!("brief", &payload.brief);
    set_doc_field!("content", &payload.content);
    set_doc_field!("status", &payload.status);
    conn.query_row(
        "SELECT id, title, doc_type, brief, content, status, created_at, updated_at
         FROM documents WHERE id = ?1",
        [payload.id],
        |row| row_to_document(row),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_document(app: tauri::AppHandle, id: i64) -> Result<(), String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;
    conn.execute("DELETE FROM documents WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn ai_draft_document(
    app: tauri::AppHandle,
    id: i64,
    model: String,
) -> Result<Document, String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;
    let doc: Document = conn
        .query_row(
            "SELECT id, title, doc_type, brief, content, status, created_at, updated_at
             FROM documents WHERE id = ?1",
            [id],
            |row| row_to_document(row),
        )
        .map_err(|e| e.to_string())?;

    let brief = doc.brief.as_deref().unwrap_or("").trim().to_owned();
    if brief.is_empty() {
        return Err("Add a brief description before generating.".to_owned());
    }

    let settings = get_generation_settings(app.clone())?;
    let booking_url = {
        let c = open_database(&app)?;
        get_setting_value(&c, "booking_url")?.unwrap_or_default()
    };
    let booking_note = if !booking_url.is_empty() {
        format!("\nBooking / scheduling link to include where relevant: {booking_url}")
    } else {
        String::new()
    };

    let doc_type_label = match doc.doc_type.as_str() {
        "proposal" => "business proposal",
        "report" => "executive report",
        "memo" => "internal memo",
        "deck_outline" => "presentation outline",
        _ => doc.doc_type.as_str(),
    };

    let prompt = format!(
        "You are an executive ghostwriter for {sender_name}, {sender_position} at {sender_company}.\n\
         Write a professional {doc_type_label}.\n\n\
         BRIEF:\n{brief}{booking_note}\n\n\
         Write the full document. Use clear headings, concise paragraphs, and a confident executive tone. \
         Output the document text only — no commentary, no preamble.",
        sender_name = settings.sender_name,
        sender_position = settings.sender_position,
        sender_company = settings.sender_company,
    );

    let content = call_ollama_generate(&model, &prompt)?;

    conn.execute(
        "UPDATE documents SET content = ?1, status = 'draft', updated_at = CURRENT_TIMESTAMP WHERE id = ?2",
        params![content, id],
    )
    .map_err(|e| e.to_string())?;

    conn.query_row(
        "SELECT id, title, doc_type, brief, content, status, created_at, updated_at
         FROM documents WHERE id = ?1",
        [id],
        |row| row_to_document(row),
    )
    .map_err(|e| e.to_string())
}

// ── Contact 360 ──────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct ContactEmail {
    campaign_name: String,
    subject: String,
    body: String,
    status: String,
    created_at: String,
}

#[derive(Serialize)]
struct ContactDeal {
    id: i64,
    title: String,
    stage: String,
    value_text: Option<String>,
    next_action: Option<String>,
    next_action_date: Option<String>,
}

#[derive(Serialize)]
struct ContactTask {
    id: i64,
    title: String,
    status: String,
    priority: String,
    due_date: Option<String>,
}

#[derive(Serialize)]
struct ContactMentionedMeeting {
    id: i64,
    title: String,
    meeting_date: Option<String>,
    summary: Option<String>,
}

#[derive(Serialize)]
struct ContactProfile {
    id: i64,
    name: String,
    email: String,
    company: String,
    industry: String,
    notes: Option<String>,
    last_contacted_at: String,
    emails: Vec<ContactEmail>,
    deals: Vec<ContactDeal>,
    tasks: Vec<ContactTask>,
    meetings: Vec<ContactMentionedMeeting>,
}

#[tauri::command]
fn get_contact_profile(app: tauri::AppHandle, client_id: i64) -> Result<ContactProfile, String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;

    let (id, name, email, industry, company, notes, last_contacted_at): (i64, String, String, String, String, Option<String>, String) = conn
        .query_row(
            "SELECT id, name, email, industry, COALESCE(company,''), notes, COALESCE(last_contacted_at,'')
             FROM clients WHERE id = ?1",
            [client_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
        )
        .map_err(|e| e.to_string())?;

    // Emails sent
    let mut stmt = conn.prepare(
        "SELECT COALESCE(cp.name,'Round'), d.subject, d.body, d.status, d.created_at
         FROM drafts d
         LEFT JOIN campaigns cp ON cp.id = d.campaign_id
         WHERE d.client_id = ?1
         ORDER BY d.created_at DESC LIMIT 15",
    ).map_err(|e| e.to_string())?;
    let emails: Vec<ContactEmail> = stmt.query_map([client_id], |r| {
        Ok(ContactEmail { campaign_name: r.get(0)?, subject: r.get(1)?, body: r.get(2)?, status: r.get(3)?, created_at: r.get(4)? })
    }).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();

    // Deals matched by email or company name
    let company_lower = company.to_lowercase();
    let email_lower = email.to_lowercase();
    let mut stmt = conn.prepare(
        "SELECT id, title, stage, value_text, next_action, next_action_date
         FROM deals
         WHERE LOWER(COALESCE(contact_email,'')) = ?1 OR LOWER(COALESCE(company,'')) = ?2
         ORDER BY updated_at DESC LIMIT 5",
    ).map_err(|e| e.to_string())?;
    let deals: Vec<ContactDeal> = stmt.query_map(
        rusqlite::params![email_lower, company_lower],
        |r| Ok(ContactDeal { id: r.get(0)?, title: r.get(1)?, stage: r.get(2)?, value_text: r.get(3)?, next_action: r.get(4)?, next_action_date: r.get(5)? }),
    ).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();

    // Tasks mentioning this contact's name or company
    let name_pattern = format!("%{}%", name.to_lowercase());
    let company_pattern = format!("%{}%", company_lower);
    let mut stmt = conn.prepare(
        "SELECT id, title, status, priority, due_date FROM tasks
         WHERE LOWER(title) LIKE ?1 OR LOWER(COALESCE(description,'')) LIKE ?2 OR LOWER(title) LIKE ?3
         ORDER BY created_at DESC LIMIT 8",
    ).map_err(|e| e.to_string())?;
    let tasks: Vec<ContactTask> = stmt.query_map(
        rusqlite::params![name_pattern, name_pattern, company_pattern],
        |r| Ok(ContactTask { id: r.get(0)?, title: r.get(1)?, status: r.get(2)?, priority: r.get(3)?, due_date: r.get(4)? }),
    ).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();

    // Meetings mentioning company name in attendees, title, or notes
    let mut stmt = conn.prepare(
        "SELECT id, title, meeting_date, summary FROM meetings
         WHERE LOWER(COALESCE(attendees,'')) LIKE ?1
            OR LOWER(title) LIKE ?1
            OR LOWER(COALESCE(raw_notes,'')) LIKE ?1
            OR LOWER(COALESCE(summary,'')) LIKE ?1
         ORDER BY meeting_date DESC LIMIT 5",
    ).map_err(|e| e.to_string())?;
    let search_pat = format!("%{}%", if company_lower.is_empty() { name.to_lowercase() } else { company_lower.clone() });
    let meetings: Vec<ContactMentionedMeeting> = stmt.query_map(
        [&search_pat],
        |r| Ok(ContactMentionedMeeting { id: r.get(0)?, title: r.get(1)?, meeting_date: r.get(2)?, summary: r.get(3)? }),
    ).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();

    Ok(ContactProfile { id, name, email, company, industry, notes, last_contacted_at, emails, deals, tasks, meetings })
}

// ── Home briefing ─────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct HomeBriefing {
    text: String,
    pending_approvals: i64,
    overdue_tasks: i64,
    stale_deals: i64,
}

#[tauri::command]
fn get_home_briefing(app: tauri::AppHandle, model: String) -> Result<HomeBriefing, String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;

    let pending_approvals: i64 = conn
        .query_row("SELECT COUNT(*) FROM drafts WHERE status='review_required'", [], |r| r.get(0))
        .unwrap_or(0);

    let overdue_tasks: i64 = conn
        .query_row("SELECT COUNT(*) FROM tasks WHERE status != 'done' AND due_date IS NOT NULL AND due_date < date('now')", [], |r| r.get(0))
        .unwrap_or(0);

    let stale_deals: i64 = conn
        .query_row("SELECT COUNT(*) FROM deals WHERE stage NOT IN ('won','lost') AND julianday('now') - julianday(updated_at) >= 7", [], |r| r.get(0))
        .unwrap_or(0);

    // Gather overdue task names
    let overdue_task_titles: Vec<String> = conn
        .prepare("SELECT title FROM tasks WHERE status != 'done' AND due_date IS NOT NULL AND due_date < date('now') ORDER BY due_date LIMIT 4")
        .map(|mut s| s.query_map([], |r| r.get::<_, String>(0)).map(|rows| rows.filter_map(|r| r.ok()).collect::<Vec<_>>()).unwrap_or_default())
        .unwrap_or_default();

    // Gather most stale active deal
    let stale_deal: Option<(String, String, i64)> = conn
        .prepare("SELECT title, stage, CAST(julianday('now') - julianday(updated_at) AS INTEGER) FROM deals WHERE stage NOT IN ('won','lost') AND julianday('now') - julianday(updated_at) >= 7 ORDER BY updated_at ASC LIMIT 1")
        .map(|mut s| s.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?))).map(|rows| rows.filter_map(|r| r.ok()).next()).unwrap_or(None))
        .unwrap_or(None);

    // Gather tasks due within the next 3 days (not overdue)
    let due_soon: Vec<(String, String)> = conn
        .prepare("SELECT title, due_date FROM tasks WHERE status != 'done' AND due_date IS NOT NULL AND due_date >= date('now') AND due_date <= date('now', '+3 days') ORDER BY due_date LIMIT 3")
        .map(|mut s| s.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map(|rows| rows.filter_map(|r| r.ok()).collect::<Vec<_>>()).unwrap_or_default())
        .unwrap_or_default();

    // Build the briefing from real data — no LLM, no hallucinations
    let mut sentences: Vec<String> = Vec::new();

    if pending_approvals > 0 {
        sentences.push(format!(
            "{} email draft{} waiting for your approval.",
            pending_approvals,
            if pending_approvals == 1 { " is" } else { "s are" }
        ));
    }

    if !overdue_task_titles.is_empty() {
        let count = overdue_task_titles.len();
        let names = if count == 1 {
            format!("\"{}\"", overdue_task_titles[0])
        } else if count == 2 {
            format!("\"{}\" and \"{}\"", overdue_task_titles[0], overdue_task_titles[1])
        } else {
            format!("\"{}\" and {} others", overdue_task_titles[0], count - 1)
        };
        sentences.push(format!(
            "{} overdue task{}: {}.",
            count,
            if count == 1 { "" } else { "s" },
            names
        ));
    }

    if let Some((title, stage, days)) = stale_deal {
        sentences.push(format!(
            "\"{}\" ({}) hasn't moved in {} day{} — worth a nudge today.",
            title, stage, days, if days == 1 { "" } else { "s" }
        ));
    } else if stale_deals > 1 {
        sentences.push(format!(
            "{} deals have had no activity in 7+ days.",
            stale_deals
        ));
    }

    if !due_soon.is_empty() {
        let items: Vec<String> = due_soon.iter()
            .map(|(t, d)| format!("\"{}\" ({})", t, d))
            .collect();
        sentences.push(format!("Coming up soon: {}.", items.join(", ")));
    }

    let text = if sentences.is_empty() {
        "All clear — nothing urgent in your workspace today.".to_owned()
    } else {
        sentences.join(" ")
    };

    let _ = model; // kept in signature for API compatibility

    Ok(HomeBriefing { text, pending_approvals, overdue_tasks, stale_deals })
}

fn chrono_today() -> String {
    // SQLite date('now') format
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let days = secs / 86400;
    // days since epoch (1970-01-01)
    let mut y = 1970u32;
    let mut remaining = days as u32;
    loop {
        let days_in_year = if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) { 366 } else { 365 };
        if remaining < days_in_year { break; }
        remaining -= days_in_year;
        y += 1;
    }
    let month_days = [31u32, if y%4==0&&(y%100!=0||y%400==0) {29} else {28}, 31,30,31,30,31,31,30,31,30,31];
    let mut m = 0usize;
    while m < 12 && remaining >= month_days[m] {
        remaining -= month_days[m];
        m += 1;
    }
    format!("{}-{:02}-{:02}", y, m + 1, remaining + 1)
}

// ── AI workspace chat ─────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ChatMessage {
    role: String,
    content: String,
}

#[tauri::command]
fn chat_workspace(
    app: tauri::AppHandle,
    model: String,
    message: String,
    history: Vec<ChatMessage>,
) -> Result<String, String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;
    let settings = get_generation_settings(app.clone())?;

    // Build workspace snapshot for context
    let mut ctx: Vec<String> = Vec::new();
    ctx.push(format!("Today: {}", chrono_today()));

    // Pending drafts
    let pending: i64 = conn.query_row("SELECT COUNT(*) FROM drafts WHERE status='review_required'", [], |r| r.get(0)).unwrap_or(0);
    if pending > 0 { ctx.push(format!("Email drafts pending approval: {}", pending)); }

    // Open tasks
    if let Ok(mut stmt) = conn.prepare("SELECT title, status, priority, COALESCE(due_date,'') FROM tasks WHERE status != 'done' ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END LIMIT 20") {
        let lines: Vec<String> = stmt.query_map([], |r| {
            Ok(format!("[{}][{}] {}{}", r.get::<_,String>(2)?, r.get::<_,String>(1)?, r.get::<_,String>(0)?, {
                let d:String=r.get(3)?; if d.is_empty() {String::new()} else {format!(" (due {})",d)}
            }))
        }).map(|rows| rows.filter_map(|r| r.ok()).collect::<Vec<_>>()).unwrap_or_default();
        if !lines.is_empty() { ctx.push(format!("Open tasks:\n{}", lines.join("\n"))); }
    }

    // Active deals
    if let Ok(mut stmt) = conn.prepare("SELECT title, stage, COALESCE(company,''), COALESCE(contact_name,''), COALESCE(value_text,''), COALESCE(next_action,''), COALESCE(next_action_date,''), CAST(julianday('now')-julianday(updated_at) AS INTEGER) FROM deals WHERE stage NOT IN ('won','lost') ORDER BY updated_at ASC LIMIT 20") {
        let lines: Vec<String> = stmt.query_map([], |r| {
            let days: i64 = r.get(7)?;
            Ok(format!("{} | {} | {} | {} | value:{} | next:{} {} | {}d idle",
                r.get::<_,String>(0)?, r.get::<_,String>(1)?, r.get::<_,String>(2)?,
                r.get::<_,String>(3)?, r.get::<_,String>(4)?, r.get::<_,String>(5)?,
                r.get::<_,String>(6)?, days))
        }).map(|rows| rows.filter_map(|r| r.ok()).collect::<Vec<_>>()).unwrap_or_default();
        if !lines.is_empty() { ctx.push(format!("Pipeline:\n{}", lines.join("\n"))); }
    }

    // Recent meetings + summaries
    if let Ok(mut stmt) = conn.prepare("SELECT title, COALESCE(meeting_date,''), COALESCE(attendees,''), COALESCE(summary,'') FROM meetings ORDER BY meeting_date DESC LIMIT 10") {
        let lines: Vec<String> = stmt.query_map([], |r| {
            Ok(format!("{} ({}) attendees:{}\n  summary: {}", r.get::<_,String>(0)?, r.get::<_,String>(1)?, r.get::<_,String>(2)?, r.get::<_,String>(3)?))
        }).map(|rows| rows.filter_map(|r| r.ok()).collect::<Vec<_>>()).unwrap_or_default();
        if !lines.is_empty() { ctx.push(format!("Recent meetings:\n{}", lines.join("\n\n"))); }
    }

    // Contacts count
    let contact_count: i64 = conn.query_row("SELECT COUNT(*) FROM clients", [], |r| r.get(0)).unwrap_or(0);
    ctx.push(format!("Total contacts in system: {}", contact_count));

    // Knowledge docs
    if let Ok(mut stmt) = conn.prepare("SELECT name, doc_type, SUBSTR(content,1,300) FROM knowledge_documents ORDER BY doc_type, id LIMIT 10") {
        let lines: Vec<String> = stmt.query_map([], |r| {
            Ok(format!("[{}] {}: {}", r.get::<_,String>(1)?, r.get::<_,String>(0)?, r.get::<_,String>(2)?))
        }).map(|rows| rows.filter_map(|r| r.ok()).collect::<Vec<_>>()).unwrap_or_default();
        if !lines.is_empty() { ctx.push(format!("Knowledge base:\n{}", lines.join("\n"))); }
    }

    let workspace = ctx.join("\n\n");

    // Build chat history for multi-turn context (last 8 turns)
    let history_text: String = history.iter().rev().take(8).rev()
        .map(|m| format!("{}: {}", if m.role == "user" { "User" } else { "Assistant" }, m.content))
        .collect::<Vec<_>>().join("\n");

    let prompt = format!(
        "You are the personal AI executive assistant for {name}, {position} at {company}.\n\
         You have full context of their workspace — tasks, deals, meetings, outreach, and contacts.\n\
         Answer questions directly and specifically. When relevant, cite deal names, task titles, or dates from the data.\n\
         Be concise. Use bullet points only when listing multiple items. Never make up information not in the workspace.\n\n\
         WORKSPACE DATA:\n{workspace}\n\n\
         {history_section}\
         User: {message}\n\
         Assistant:",
        name = settings.sender_name,
        position = settings.sender_position,
        company = settings.sender_company,
        workspace = workspace,
        history_section = if history_text.is_empty() { String::new() } else { format!("CONVERSATION HISTORY:\n{}\n\n", history_text) },
        message = message,
    );

    call_ollama_generate(&model, &prompt)
}

#[derive(Serialize)]
struct GeneratedRule {
    name: String,
    tone: String,
    subject_template: String,
    body_template: String,
    system_prompt: String,
}

#[tauri::command]
fn ai_generate_rule(model: String, industry: String) -> Result<GeneratedRule, String> {
    let industry = industry.trim().to_owned();
    if industry.is_empty() {
        return Err("Enter an industry before generating.".to_owned());
    }

    let prompt = format!(
        "You are a creative outbound email strategist.\n\
         Generate an original, high-converting cold outreach template specifically for the {industry} industry.\n\
         Be creative — avoid generic phrasing. Make it feel human, specific, and compelling.\n\n\
         Use these placeholders: {{{{name}}}}, {{{{company}}}}, {{{{industry}}}}, {{{{sender_name}}}}, {{{{sender_position}}}}, {{{{sender_company}}}}.\n\n\
         Output ONLY the following fields, each on its own line, with NO extra commentary:\n\
         Name: <a creative name for this rule, e.g. \"Retail Growth Intro\">\n\
         Tone: <tone description, e.g. \"Direct, confident, peer-to-peer\">\n\
         Subject: <subject line template>\n\
         Body: <full email body template — multi-line is fine>\n\
         Guidance: <2-3 sentences of writing guidance specific to this industry>",
        industry = industry,
    );

    let raw = call_ollama_generate(&model, &prompt)?;

    let get = |label: &str| -> String {
        let prefix = format!("{label}:");
        for line in raw.lines() {
            if line.trim_start().starts_with(&prefix) {
                return line.trim_start()[prefix.len()..].trim().to_owned();
            }
        }
        String::new()
    };

    let body_prefix = "Body:";
    let guidance_prefix = "Guidance:";
    let body_template = {
        let mut capturing = false;
        let mut lines: Vec<&str> = Vec::new();
        for line in raw.lines() {
            if line.trim_start().starts_with(body_prefix) {
                capturing = true;
                let rest = line.trim_start()[body_prefix.len()..].trim();
                if !rest.is_empty() { lines.push(rest); }
                continue;
            }
            if capturing {
                if line.trim_start().starts_with(guidance_prefix) { break; }
                lines.push(line);
            }
        }
        lines.join("\n").trim().to_owned()
    };

    let system_prompt = get("Guidance");

    Ok(GeneratedRule {
        name: get("Name"),
        tone: get("Tone"),
        subject_template: get("Subject"),
        body_template,
        system_prompt,
    })
}

#[derive(Serialize)]
struct ContactHistoryRecord {
    campaign_name: String,
    subject: String,
    body_preview: String,
    status: String,
    created_at: String,
}

#[tauri::command]
fn get_contact_history(app: tauri::AppHandle, email: String) -> Result<Vec<ContactHistoryRecord>, String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;
    let mut stmt = conn
        .prepare(
            "SELECT COALESCE(cp.name, 'Round'), d.subject, d.body, d.status, d.created_at
             FROM drafts d
             JOIN clients c ON c.id = d.client_id
             LEFT JOIN campaigns cp ON cp.id = d.campaign_id
             WHERE LOWER(c.email) = LOWER(?1)
             ORDER BY d.created_at DESC
             LIMIT 20",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([email.trim()], |row| {
            let body: String = row.get(2)?;
            let preview = body.chars().take(200).collect::<String>();
            Ok(ContactHistoryRecord {
                campaign_name: row.get(0)?,
                subject: row.get(1)?,
                body_preview: preview,
                status: row.get(3)?,
                created_at: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut records = Vec::new();
    for row in rows {
        records.push(row.map_err(|e| e.to_string())?);
    }
    Ok(records)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let ollama_process: OllamaProcess = std::sync::Arc::new(std::sync::Mutex::new(None));
    let ollama_for_cleanup = std::sync::Arc::clone(&ollama_process);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .manage(ollama_process)
        .setup(|app| {
            let app_handle = app.handle().clone();
            thread::spawn(move || loop {
                thread::sleep(Duration::from_secs(60));
                check_scheduled_sends(&app_handle);
            });
            Ok(())
        })
        .on_window_event(move |_window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(child) = ollama_for_cleanup.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            check_ollama_health,
            initialize_local_store,
            save_imported_clients,
            count_clients,
            list_clients,
            add_single_client,
            bulk_approve_drafts,
            seed_default_templates,
            list_templates,
            upsert_template,
            get_generation_settings,
            set_generation_settings,
            list_ollama_models,
            list_campaigns,
            generate_drafts,
            start_generate_drafts,
            get_generation_job_status,
            list_drafts,
            update_draft,
            regenerate_draft,
            delete_draft,
            delete_campaign,
            delete_client,
            reset_workspace_data,
            get_workflow_summary,
            send_approved_drafts,
            mark_exported_drafts,
            list_history,
            get_email_settings,
            set_email_settings,
            test_smtp_connection,
            start_send_campaign_drafts,
            schedule_campaign_send,
            get_campaign_send_status,
            list_knowledge_docs,
            save_knowledge_doc,
            update_knowledge_doc_content,
            delete_knowledge_doc,
            update_client_notes,
            list_tasks,
            create_task,
            update_task,
            delete_task,
            list_meetings,
            create_meeting,
            update_meeting,
            delete_meeting,
            ai_summarize_meeting,
            list_deals,
            create_deal,
            update_deal,
            delete_deal,
            list_documents,
            create_document,
            update_document,
            delete_document,
            ai_draft_document,
            ai_generate_rule,
            get_contact_history,
            get_contact_profile,
            get_home_briefing,
            chat_workspace,
            ensure_ollama_running,
            pull_ollama_model
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
