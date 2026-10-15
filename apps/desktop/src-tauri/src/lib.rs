use std::borrow::Cow;

use serde::Serialize;
use tauri::Manager;

mod local_api;

#[derive(Serialize)]
struct ResumeListItem {
    id: String,
    name: String,
}

fn new_resume_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}")
}

fn database_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    if let Ok(path) = std::env::var("REACTIVE_RESUME_DB") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return Ok(std::path::PathBuf::from(trimmed));
        }
    }
    let directory = app.path().app_data_dir().map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join("resumes.sqlite"))
}

fn with_resume_db<T>(
    app: &tauri::AppHandle,
    body: impl FnOnce(&rusqlite::Connection) -> Result<T, String>,
) -> Result<T, String> {
    let path = database_path(app)?;
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
    }
    let connection = rusqlite::Connection::open(path).map_err(|error| error.to_string())?;
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS resume (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                document TEXT NOT NULL
            )",
        )
        .map_err(|error| error.to_string())?;
    body(&connection)
}

#[tauri::command]
fn list_resumes(app: tauri::AppHandle) -> Result<Vec<ResumeListItem>, String> {
    with_resume_db(&app, |connection| {
        let mut statement = connection
            .prepare("SELECT id, name FROM resume ORDER BY rowid")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok(ResumeListItem {
                    id: row.get(0)?,
                    name: row.get(1)?,
                })
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    })
}

#[tauri::command]
fn create_resume(
    app: tauri::AppHandle,
    name: String,
    document: serde_json::Value,
) -> Result<ResumeListItem, String> {
    let id = new_resume_id();
    let stored = document.to_string();
    with_resume_db(&app, |connection| {
        connection
            .execute(
                "INSERT INTO resume (id, name, document) VALUES (?1, ?2, ?3)",
                rusqlite::params![id, name, stored],
            )
            .map_err(|error| error.to_string())?;
        Ok(ResumeListItem { id, name })
    })
}

#[tauri::command]
fn rename_resume(app: tauri::AppHandle, id: String, name: String) -> Result<(), String> {
    with_resume_db(&app, |connection| {
        let updated = connection
            .execute(
                "UPDATE resume SET name = ?1 WHERE id = ?2",
                rusqlite::params![name, id],
            )
            .map_err(|error| error.to_string())?;
        if updated == 0 {
            return Err(format!("Resume {id} was not found"));
        }
        Ok(())
    })
}

#[derive(Serialize)]
struct ResumeRecord {
    id: String,
    name: String,
    document: serde_json::Value,
}

#[tauri::command]
fn read_resume(app: tauri::AppHandle, id: String) -> Result<ResumeRecord, String> {
    with_resume_db(&app, |connection| {
        let (resume_id, name, document) = connection
            .query_row(
                "SELECT id, name, document FROM resume WHERE id = ?1",
                rusqlite::params![id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get::<_, String>(2)?)),
            )
            .map_err(|error| error.to_string())?;
        let parsed = serde_json::from_str(&document).map_err(|error| error.to_string())?;
        Ok(ResumeRecord {
            id: resume_id,
            name,
            document: parsed,
        })
    })
}

#[tauri::command]
fn save_resume(app: tauri::AppHandle, id: String, document: serde_json::Value) -> Result<(), String> {
    let stored = document.to_string();
    with_resume_db(&app, |connection| {
        let updated = connection
            .execute(
                "UPDATE resume SET document = ?1 WHERE id = ?2",
                rusqlite::params![stored, id],
            )
            .map_err(|error| error.to_string())?;
        if updated == 0 {
            return Err(format!("Resume {id} was not found"));
        }
        Ok(())
    })
}

#[tauri::command]
fn delete_resume(app: tauri::AppHandle, id: String) -> Result<(), String> {
    with_resume_db(&app, |connection| {
        connection
            .execute("DELETE FROM resume WHERE id = ?1", rusqlite::params![id])
            .map_err(|error| error.to_string())?;
        Ok(())
    })
}

fn font_cache_directory() -> std::path::PathBuf {
    match std::env::var("REACTIVE_RESUME_FONT_CACHE") {
        Ok(directory) => std::path::PathBuf::from(directory),
        Err(_) => std::env::temp_dir().join("reactive-resume-font-cache"),
    }
}

fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok()?;
            decoded.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

fn prepared_font_path(path: &str) -> Option<std::path::PathBuf> {
    let segments: Vec<&str> = path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    if segments.len() != 3 {
        return None;
    }
    let family = percent_decode(segments.first().copied()?)?;
    let weight = percent_decode(segments.get(1).copied()?)?;
    let italic = percent_decode(segments.get(2).copied()?)?;
    if family.is_empty()
        || family.contains(['/', '\\'])
        || family.contains("..")
        || !weight.chars().all(|character| character.is_ascii_digit())
        || (italic != "true" && italic != "false")
    {
        return None;
    }
    Some(font_cache_directory().join(format!("{family}-{weight}-{italic}.ttf")))
}

fn font_response(status: u16, body: Vec<u8>) -> tauri::http::Response<Cow<'static, [u8]>> {
    tauri::http::Response::builder()
        .status(status)
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Allow-Private-Network", "true")
        .header("Content-Type", "font/ttf")
        .body(Cow::Owned(body))
        .expect("font cache response")
}

fn read_prepared_font(
    request: &tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Cow<'static, [u8]>> {
    if request.method() == tauri::http::Method::OPTIONS {
        return tauri::http::Response::builder()
            .status(204)
            .header("Access-Control-Allow-Origin", "*")
            .header("Access-Control-Allow-Methods", "GET, OPTIONS")
            .header("Access-Control-Allow-Private-Network", "true")
            .header("Access-Control-Allow-Headers", "*")
            .body(Cow::Owned(Vec::new()))
            .expect("font cache preflight");
    }
    let Some(path) = prepared_font_path(request.uri().path()) else {
        return font_response(404, Vec::new());
    };
    match std::fs::read(path) {
        Ok(bytes) => font_response(200, bytes),
        Err(_) => font_response(404, Vec::new()),
    }
}

const CREDENTIAL_SERVICE: &str = "dev.reactivresume.desktop";
const CREDENTIAL_USER: &str = "assistant";

fn data_directory() -> std::path::PathBuf {
    match std::env::var("REACTIVE_RESUME_DATA_DIR") {
        Ok(directory) => std::path::PathBuf::from(directory),
        Err(_) => std::env::temp_dir().join("reactive-resume-data"),
    }
}

fn write_text(file_name: &str, contents: &str) -> Result<(), String> {
    let directory = data_directory();
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    std::fs::write(directory.join(file_name), contents).map_err(|error| error.to_string())
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderSettings {
    base_url: String,
    model: String,
}

fn credential_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(CREDENTIAL_SERVICE, CREDENTIAL_USER).map_err(|error| error.to_string())
}

fn store_api_key(api_key: &str) -> Result<(), String> {
    let entry = credential_entry()?;
    if api_key.is_empty() {
        return match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error.to_string()),
        };
    }
    entry.set_password(api_key).map_err(|error| error.to_string())
}

fn stored_api_key() -> Result<String, String> {
    match credential_entry()?.get_password() {
        Ok(api_key) => Ok(api_key),
        Err(keyring::Error::NoEntry) => Ok(String::new()),
        Err(error) => Err(error.to_string()),
    }
}

fn read_provider() -> Result<ProviderSettings, String> {
    let bytes = std::fs::read(data_directory().join("provider.json")).map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes).map_err(|error| error.to_string())
}

fn chat_completions_url(base_url: &str) -> Result<String, String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.chars().any(char::is_whitespace)
        || !(trimmed.starts_with("http://") || trimmed.starts_with("https://"))
    {
        return Err("Provider URL must be an http(s) address".to_string());
    }
    Ok(format!("{trimmed}/chat/completions"))
}

fn provider_failure(error: ureq::Error) -> String {
    match error {
        ureq::Error::Status(status, response) => {
            let body = response.into_string().unwrap_or_default();
            format!("Provider replied {status}: {body}")
        }
        other => other.to_string(),
    }
}

fn perform_ask(resume: String) -> Result<String, String> {
    let settings = read_provider().map_err(|_| "Provider is not configured".to_string())?;
    if settings.base_url.trim().is_empty() || settings.model.trim().is_empty() {
        return Err("Provider is not configured".to_string());
    }
    let url = chat_completions_url(&settings.base_url)?;
    let api_key = stored_api_key()?;
    write_text("resume.json", &resume)?;
    let payload = serde_json::json!({
        "model": settings.model,
        "messages": [{ "role": "user", "content": resume }],
    });
    let agent = ureq::AgentBuilder::new()
        .redirects(0)
        .timeout(std::time::Duration::from_secs(60))
        .build();
    let request = agent.post(&url).set("Content-Type", "application/json");
    let response = if api_key.is_empty() {
        request.send_json(payload)
    } else {
        request
            .set("Authorization", &format!("Bearer {api_key}"))
            .send_json(payload)
    }
    .map_err(provider_failure)?;
    let body: serde_json::Value = response.into_json().map_err(|error| error.to_string())?;
    body.pointer("/choices/0/message/content")
        .and_then(serde_json::Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| "Provider reply did not include a message".to_string())
}

#[tauri::command]
fn save_provider(base_url: String, model: String, api_key: String) -> Result<(), String> {
    let settings = ProviderSettings {
        base_url: base_url.trim().to_string(),
        model: model.trim().to_string(),
    };
    write_text(
        "provider.json",
        &serde_json::to_string(&settings).map_err(|error| error.to_string())?,
    )?;
    store_api_key(api_key.trim())
}

#[tauri::command]
fn load_provider() -> ProviderSettings {
    read_provider().unwrap_or(ProviderSettings {
        base_url: String::new(),
        model: String::new(),
    })
}

#[tauri::command]
async fn ask_assistant(resume: String) -> Result<String, String> {
    match tauri::async_runtime::spawn_blocking(move || perform_ask(resume)).await {
        Ok(result) => result,
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn save_resume_pdf(pdf_base64: String) -> Result<String, String> {
    let bytes = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        pdf_base64.trim(),
    )
    .map_err(|error| error.to_string())?;
    let directory = std::env::var("REACTIVE_RESUME_EXPORT_DIR").unwrap_or_else(|_| {
        std::env::temp_dir()
            .join("reactive-resume-export")
            .to_string_lossy()
            .into_owned()
    });
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let path = std::path::Path::new(&directory).join("resume.pdf");
    std::fs::write(&path, bytes).map_err(|error| error.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

fn browser_args() -> Option<String> {
    let port = std::env::var("REACTIVE_RESUME_DEBUG_PORT").ok()?;
    if !port.chars().all(|character| character.is_ascii_digit()) {
        return None;
    }
    Some(format!(
        "--remote-debugging-port={port} --remote-allow-origins=* --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection"
    ))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            save_resume_pdf,
            list_resumes,
            create_resume,
            rename_resume,
            read_resume,
            save_resume,
            delete_resume,
            save_provider,
            load_provider,
            ask_assistant
        ])
        .register_uri_scheme_protocol("fontcache", |_ctx, request| read_prepared_font(&request))
		.setup(|app| {
			let _ = app;
			let data_directory = local_api::database_file()
				.parent()
				.map(std::path::Path::to_path_buf)
				.unwrap_or_else(|| std::path::PathBuf::from("desktop-data"));
			std::fs::create_dir_all(&data_directory).ok();
			let mut path = std::env::var("PATH").unwrap_or_default();
			path = format!(r"C:\Program Files\nodejs;C:\Users\Administrator\AppData\Roaming\npm;{path}");
			let workspace = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
			let server = command_without_window("cmd")
				.current_dir(&workspace)
				.env("PATH", path)
				.env("DESKTOP_DATA_DIR", &data_directory)
				.env("DESKTOP_SQLITE", data_directory.join("resumes.sqlite"))
				.env("PORT", local_api::PORT.to_string())
				.args(["/c", "pnpm", "--filter", "server", "exec", "tsx", "src/desktop-host.ts"])
				.spawn()
				.expect("start the v6 server");
			app.manage(ServerPid(server.id()));
			let mut healthy = false;
			for _ in 0..120 {
				if ureq::get(&format!("http://127.0.0.1:{}/api/health", local_api::PORT))
					.call()
					.is_ok()
				{
					healthy = true;
					break;
				}
				std::thread::sleep(std::time::Duration::from_millis(500));
			}
			if !healthy {
				panic!("desktop server did not become healthy");
			}
			let url = format!("http://127.0.0.1:{}/desktop/enter", local_api::PORT)
				.parse()
				.expect("local url");
			let mut builder = tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External(url))
            .title("Reactive Resume")
            .inner_size(1440.0, 900.0)
            .resizable(true);
            if let Some(args) = browser_args() {
                builder = builder.additional_browser_args(&args);
            }
            builder.build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(pid) = app.try_state::<ServerPid>() {
                    let _ = command_without_window("taskkill")
                        .args(["/pid", &pid.0.to_string(), "/T", "/F"])
                        .status();
                }
            }
        });
}

struct ServerPid(u32);

fn command_without_window(program: &str) -> std::process::Command {
	let mut command = std::process::Command::new(program);
	#[cfg(windows)]
	{
		use std::os::windows::process::CommandExt;
		command.creation_flags(0x08000000);
	}
	command
}
