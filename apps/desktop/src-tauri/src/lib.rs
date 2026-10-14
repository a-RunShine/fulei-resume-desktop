use std::borrow::Cow;

use serde::Serialize;
use tauri::Manager;

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
            delete_resume
        ])
        .register_uri_scheme_protocol("fontcache", |_ctx, request| read_prepared_font(&request))
        .setup(|app| {
            let mut builder = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Reactive Resume")
            .inner_size(900.0, 700.0)
            .resizable(true);
            if let Some(args) = browser_args() {
                builder = builder.additional_browser_args(&args);
            }
            builder.build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
