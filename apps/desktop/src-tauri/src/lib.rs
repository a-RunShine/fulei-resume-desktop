use std::borrow::Cow;
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};

use serde::Serialize;
use startup::{
    BootOutcome, BrowserHost, Clock, DesktopBoot, ProcessHost, ServerLaunch, StartupSurface,
};

mod assistant_data;
mod local_api;
mod startup;

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

fn database_path(_app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    if let Ok(path) = std::env::var("REACTIVE_RESUME_DB") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return Ok(std::path::PathBuf::from(trimmed));
        }
    }
    let directory = desktop_app_data()?;
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
fn save_resume(
    app: tauri::AppHandle,
    id: String,
    document: serde_json::Value,
) -> Result<(), String> {
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

fn assistant_data_directory() -> Result<std::path::PathBuf, String> {
    let app_data = desktop_app_data()?;
    assistant_data::resolve(&app_data).map_err(|error| error.to_string())
}

fn write_text(file_name: &str, contents: &str) -> Result<(), String> {
    let directory = assistant_data_directory()?;
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
    entry
        .set_password(api_key)
        .map_err(|error| error.to_string())
}

fn stored_api_key() -> Result<String, String> {
    match credential_entry()?.get_password() {
        Ok(api_key) => Ok(api_key),
        Err(keyring::Error::NoEntry) => Ok(String::new()),
        Err(error) => Err(error.to_string()),
    }
}

fn read_provider() -> Result<ProviderSettings, String> {
    let directory = assistant_data_directory()?;
    let bytes =
        std::fs::read(directory.join("provider.json")).map_err(|error| error.to_string())?;
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
    let server_pid = Arc::new(Mutex::new(None));
    let setup_pid = Arc::clone(&server_pid);
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
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
        .setup(move |app| {
            let handle = app.handle().clone();
            let pid = Arc::clone(&setup_pid);
            std::thread::spawn(move || {
                let outcome = boot_desktop(handle, pid);
                if outcome.exit_required() {
                    exit_after_startup_failure();
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |_app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(pid) = server_pid.lock().ok().and_then(|slot| *slot) {
                    let _ = command_without_window("taskkill")
                        .args(["/pid", &pid.to_string(), "/T", "/F"])
                        .status();
                }
            }
        });
}

fn boot_desktop(app: tauri::AppHandle, pid: Arc<Mutex<Option<u32>>>) -> BootOutcome {
    let mut surface = GuiSurface::new(app);
    let app_data = desktop_app_data();
    let executable = match std::env::current_exe() {
        Ok(executable) => executable,
        Err(error) => {
            let reason = format!("the application directory could not be resolved: {error}");
            let directory = app_data.as_deref().ok();
            return startup::fail(&mut surface, directory, &reason);
        }
    };
    let app_data = match app_data {
        Ok(app_data) => app_data,
        Err(reason) => return startup::fail(&mut surface, None, &reason),
    };
    let runtime_override = startup::runtime_override();
    let mut clock = SystemClock;
    let mut browser = SystemBrowser;
    let mut processes = SystemProcess { pid };
    let instance_lock = app_data.join("instance.lock");
    let mut boot = DesktopBoot {
        executable: &executable,
        runtime_override: runtime_override.as_deref(),
        app_data: &app_data,
        instance_lock: &instance_lock,
        port: local_api::PORT,
        clock: &mut clock,
        surface: &mut surface,
        browser: &mut browser,
        processes: &mut processes,
    };
    startup::start(&mut boot)
}

fn exit_after_startup_failure() -> ! {
    std::process::exit(1);
}

fn show_native_message(reason: &str) {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
    let title: Vec<u16> = std::ffi::OsStr::new("Fulei Resume")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let body: Vec<u16> = std::ffi::OsStr::new(reason)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let _ = std::panic::catch_unwind(|| unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            body.as_ptr(),
            title.as_ptr(),
            MB_OK | MB_ICONERROR,
        );
    });
}

fn desktop_app_data() -> Result<PathBuf, String> {
    let local_app_data =
        std::env::var("LOCALAPPDATA").map_err(|_| "LOCALAPPDATA is not set".to_string())?;
    Ok(PathBuf::from(local_app_data).join("Fulei Resume"))
}

struct SystemClock;

impl Clock for SystemClock {
    fn sleep(&mut self, duration: std::time::Duration) {
        std::thread::sleep(duration);
    }
}

struct SystemBrowser;

impl BrowserHost for SystemBrowser {
    fn evergreen_installed(&mut self) -> bool {
        evergreen_webview_installed()
    }
}

fn evergreen_webview_installed() -> bool {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;
    const CLIENT_64: &str =
        r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    const CLIENT_32: &str =
        r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    [
        (HKEY_LOCAL_MACHINE, CLIENT_32),
        (HKEY_LOCAL_MACHINE, CLIENT_64),
        (HKEY_CURRENT_USER, CLIENT_64),
    ]
    .into_iter()
    .any(|(hive, path)| {
        RegKey::predef(hive)
            .open_subkey(path)
            .ok()
            .and_then(|key| key.get_value::<String, _>("pv").ok())
            .is_some_and(|version| {
                let version = version.trim();
                !version.is_empty() && version != "0.0.0.0"
            })
    })
}

struct SystemProcess {
    pid: Arc<Mutex<Option<u32>>>,
}

impl ProcessHost for SystemProcess {
    fn spawn_server(&mut self, launch: &ServerLaunch) -> Result<u32, String> {
        if !launch.node.is_file() {
            return Err(format!(
                "Node runtime is missing: {}",
                launch.node.display()
            ));
        }
        if !launch.script.is_file() {
            return Err(format!(
                "desktop server entry is missing: {}",
                launch.script.display()
            ));
        }
        let node = launch
            .node
            .to_str()
            .ok_or_else(|| "node runtime path is not unicode".to_string())?;
        let log_path = launch
            .data_dir
            .parent()
            .map(|parent| parent.join("server.log"));
        let mut command = command_without_window(node);
        command
            .current_dir(&launch.current_dir)
            .arg(&launch.script)
            .env("DESKTOP_DATA_DIR", &launch.data_dir)
            .env("DESKTOP_WEB_DIST", &launch.web_dist)
            .env("PORT", launch.port.to_string());
        if let Some(sqlite) = &launch.legacy_sqlite {
            command.env("DESKTOP_SQLITE", sqlite);
        }
        if let Some(log_path) = log_path {
            if let Ok(log) = std::fs::File::create(&log_path) {
                let error_log = log.try_clone().map_err(|error| error.to_string())?;
                command.stdout(std::process::Stdio::from(log));
                command.stderr(std::process::Stdio::from(error_log));
            }
        }
        let child = command.spawn().map_err(|error| error.to_string())?;
        let pid = child.id();
        std::mem::forget(child);
        *self.pid.lock().map_err(|error| error.to_string())? = Some(pid);
        Ok(pid)
    }

    fn stop(&mut self, pid: u32) {
        let _ = command_without_window("taskkill")
            .args(["/pid", &pid.to_string(), "/T", "/F"])
            .status();
        if let Ok(mut slot) = self.pid.lock() {
            if *slot == Some(pid) {
                *slot = None;
            }
        }
    }
}

struct GuiSurface {
    app: tauri::AppHandle,
    window: Arc<Mutex<Option<tauri::WebviewWindow>>>,
    ready: Arc<(Mutex<bool>, Condvar)>,
    attempted: bool,
}

impl GuiSurface {
    fn new(app: tauri::AppHandle) -> Self {
        Self {
            app,
            window: Arc::new(Mutex::new(None)),
            ready: Arc::new((Mutex::new(false), Condvar::new())),
            attempted: false,
        }
    }

    fn wait_until_window_attempt_finished(&self) {
        let (lock, condition) = &*self.ready;
        let mut built = lock.lock().expect("window ready");
        while !*built {
            built = condition.wait(built).expect("window ready");
        }
    }

    fn open(&mut self, stage: &str) -> bool {
        if self.attempted {
            return self.window_exists();
        }
        self.attempted = true;
        let stage = stage.to_string();
        let app = self.app.clone();
        let window = Arc::clone(&self.window);
        let ready = Arc::clone(&self.ready);
        let queued = self.app.run_on_main_thread(move || {
            let parsed = startup_data_url(&stage).parse().expect("startup url");
            let mut builder =
                tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::External(parsed))
                    .title("Fulei Resume")
                    .inner_size(1440.0, 900.0)
                    .resizable(true);
            if let Some(args) = browser_args() {
                builder = builder.additional_browser_args(&args);
            }
            if let Ok(created) = builder.build() {
                *window.lock().expect("window") = Some(created);
            }
            let (lock, condition) = &*ready;
            *lock.lock().expect("window ready") = true;
            condition.notify_one();
        });
        if queued.is_err() {
            let (lock, condition) = &*self.ready;
            *lock.lock().expect("window ready") = true;
            condition.notify_one();
        }
        self.wait_until_window_attempt_finished();
        self.window_exists()
    }

    fn window_exists(&self) -> bool {
        self.window
            .lock()
            .map(|window| window.is_some())
            .unwrap_or(false)
    }

    fn show_reason(&self, reason: &str) -> bool {
        let quote =
            |value: &str| serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string());
        let reason = quote(reason);
        let window = Arc::clone(&self.window);
        self.app
            .run_on_main_thread(move || {
                let guard = window.lock().expect("window");
                if let Some(window) = guard.as_ref() {
                    let _ = window.eval(format!(
                        "document.body.className = 'failed'; document.querySelector('.reason').textContent = {reason};"
                    ));
                }
            })
            .is_ok()
    }
    fn update_status(&self, stage: &str) -> bool {
        let stage = stage.to_string();
        let window = Arc::clone(&self.window);
        self.app
            .run_on_main_thread(move || {
                let guard = window.lock().expect("window");
                if let Some(window) = guard.as_ref() {
                    let quoted =
                        serde_json::to_string(&stage).unwrap_or_else(|_| "\"\"".to_string());
                    let _ = window.eval(format!("document.body.className = {quoted}"));
                }
            })
            .is_ok()
    }
}

impl StartupSurface for GuiSurface {
    fn show_local(&mut self, status: &str) -> bool {
        let created_now = !self.attempted;
        if !self.open(status) {
            return false;
        }
        created_now || self.update_status(status)
    }

    fn present_failure(&mut self, reason: &str) -> BootOutcome {
        if !self.open("preparing") {
            return BootOutcome::FailedWithoutWindow;
        }
        if self.show_reason(reason) {
            BootOutcome::FailedInWindow
        } else {
            BootOutcome::FailedWithoutWindow
        }
    }

    fn report_without_window(&mut self, reason: &str) {
        show_native_message(reason);
    }

    fn navigate(&mut self, url: &str) -> Result<(), String> {
        let url = url.to_string();
        let window = Arc::clone(&self.window);
        let (sender, receiver) = std::sync::mpsc::channel();
        self.app
            .run_on_main_thread(move || {
                let outcome = navigate_on_main_thread(&window, &url);
                let _ = sender.send(outcome);
            })
            .map_err(|error| {
                let reason = format!("the main thread refused the navigation request: {error}");
                record_boot_event(&reason);
                reason
            })?;
        receiver.recv().map_err(|error| {
            let reason = format!("the navigation result was lost: {error}");
            record_boot_event(&reason);
            reason
        })?
    }
}

fn navigate_on_main_thread(window: &Arc<Mutex<Option<tauri::WebviewWindow>>>, url: &str) -> Result<(), String> {
    let guard = window.lock().map_err(|error| {
        let reason = format!("the startup window could not be reached: {error}");
        record_boot_event(&reason);
        reason
    })?;
    let Some(window) = guard.as_ref() else {
        let reason = "there is no startup window to navigate".to_string();
        record_boot_event(&reason);
        return Err(reason);
    };
    let parsed = url.parse().map_err(|error| {
        let reason = format!("the startup address could not be parsed: {error}");
        record_boot_event(&reason);
        reason
    })?;
    window.navigate(parsed).map_err(|error| {
        let reason = format!("the startup window could not navigate: {error}");
        record_boot_event(&reason);
        reason
    })
}

fn record_boot_event(reason: &str) {
    eprintln!("[desktop] {reason}");
    let Ok(directory) = desktop_app_data() else {
        return;
    };
    let log = directory.join("boot.log");
    if let Some(parent) = log.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut line = reason.to_string();
    line.push('\n');
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log)
        .and_then(|mut file| std::io::Write::write_all(&mut file, line.as_bytes()));
}

const SPLASH_MARK: &str = r##"<svg class="mark" viewBox="56.00 49.91 114 111.09" role="img" aria-label="Fulei Resume">
<path d="M62.16 51.91H92.78V60.53H74.60V67.53H90.13V75.62H74.60V92.00H62.16Z M98.45 51.91H110.84V82.13H130.17V92.00H98.45Z" fill="#111111"/>
<path d="M59.90 122.00V103.39H67.81Q70.80 103.39 72.15 103.89Q73.50 104.39 74.31 105.67Q75.13 106.96 75.13 108.61Q75.13 110.70 73.89 112.07Q72.66 113.43 70.21 113.79Q71.43 114.50 72.23 115.35Q73.02 116.20 74.36 118.37L76.64 122.00H72.14L69.43 117.95Q67.98 115.78 67.45 115.21Q66.91 114.65 66.32 114.44Q65.72 114.23 64.42 114.23H63.66V122.00ZM63.66 111.26H66.44Q69.15 111.26 69.82 111.03Q70.49 110.80 70.87 110.24Q71.25 109.69 71.25 108.85Q71.25 107.91 70.75 107.33Q70.25 106.75 69.34 106.60Q68.88 106.54 66.59 106.54H63.66Z M86.45 117.71 90.00 118.31Q89.32 120.26 87.84 121.28Q86.36 122.30 84.14 122.30Q80.62 122.30 78.93 120.01Q77.60 118.17 77.60 115.36Q77.60 112.01 79.35 110.11Q81.11 108.21 83.78 108.21Q86.79 108.21 88.53 110.20Q90.27 112.19 90.20 116.29H81.26Q81.30 117.87 82.12 118.76Q82.95 119.64 84.18 119.64Q85.02 119.64 85.59 119.18Q86.16 118.72 86.45 117.71ZM86.65 114.10Q86.62 112.55 85.85 111.75Q85.09 110.94 84.00 110.94Q82.83 110.94 82.07 111.79Q81.31 112.64 81.32 114.10Z M91.85 118.15 95.43 117.61Q95.65 118.65 96.35 119.19Q97.05 119.73 98.31 119.73Q99.69 119.73 100.39 119.22Q100.86 118.86 100.86 118.27Q100.86 117.86 100.61 117.59Q100.34 117.34 99.41 117.12Q95.10 116.17 93.94 115.39Q92.34 114.29 92.34 112.35Q92.34 110.60 93.72 109.41Q95.11 108.21 98.02 108.21Q100.78 108.21 102.13 109.11Q103.47 110.02 103.98 111.78L100.62 112.40Q100.40 111.62 99.80 111.20Q99.20 110.78 98.08 110.78Q96.67 110.78 96.06 111.17Q95.65 111.45 95.65 111.89Q95.65 112.28 96.01 112.54Q96.49 112.90 99.34 113.54Q102.19 114.19 103.32 115.13Q104.44 116.08 104.44 117.79Q104.44 119.64 102.89 120.97Q101.34 122.30 98.31 122.30Q95.55 122.30 93.95 121.19Q92.34 120.07 91.85 118.15Z M116.44 122.00V119.98Q115.70 121.06 114.50 121.68Q113.30 122.30 111.97 122.30Q110.61 122.30 109.53 121.71Q108.45 121.11 107.97 120.03Q107.49 118.95 107.49 117.05V108.52H111.05V114.71Q111.05 117.56 111.25 118.20Q111.45 118.84 111.97 119.21Q112.49 119.59 113.29 119.59Q114.20 119.59 114.93 119.09Q115.65 118.58 115.92 117.84Q116.18 117.10 116.18 114.21V108.52H119.75V122.00Z M123.18 108.52H126.47V110.36Q128.23 108.21 130.67 108.21Q131.96 108.21 132.92 108.75Q133.87 109.28 134.48 110.36Q135.37 109.28 136.39 108.75Q137.42 108.21 138.59 108.21Q140.08 108.21 141.10 108.82Q142.13 109.42 142.64 110.59Q143.01 111.45 143.01 113.38V122.00H139.44V114.29Q139.44 112.29 139.07 111.70Q138.58 110.94 137.55 110.94Q136.80 110.94 136.14 111.40Q135.48 111.86 135.19 112.74Q134.90 113.62 134.90 115.53V122.00H131.33V114.61Q131.33 112.64 131.14 112.07Q130.95 111.50 130.55 111.22Q130.15 110.94 129.46 110.94Q128.64 110.94 127.98 111.39Q127.32 111.83 127.03 112.67Q126.75 113.51 126.75 115.45V122.00H123.18Z M154.37 117.71 157.92 118.31Q157.24 120.26 155.76 121.28Q154.28 122.30 152.06 122.30Q148.54 122.30 146.85 120.01Q145.52 118.17 145.52 115.36Q145.52 112.01 147.27 110.11Q149.03 108.21 151.70 108.21Q154.71 108.21 156.45 110.20Q158.19 112.19 158.12 116.29H149.18Q149.22 117.87 150.04 118.76Q150.87 119.64 152.10 119.64Q152.94 119.64 153.51 119.18Q154.08 118.72 154.37 117.71ZM154.57 114.10Q154.54 112.55 153.77 111.75Q153.01 110.94 151.92 110.94Q150.75 110.94 149.99 111.79Q149.23 112.64 149.24 114.10Z" fill="#111111"/>
<rect x="58" y="134" width="110" height="5" rx="2.5" fill="#D6D6D6"/>
<rect x="58" y="144" width="92" height="5" rx="2.5" fill="#D6D6D6"/>
<rect x="58" y="154" width="64" height="5" rx="2.5" fill="#D6D6D6"/>
</svg>"##;

const SPLASH_TEMPLATE: &str = r##"<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>Fulei Resume</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{background:#F8F7F3;display:grid;place-items:center;overflow:hidden;font-family:"PingFang SC","Microsoft YaHei","Noto Sans SC",sans-serif}
.stage{display:flex;flex-direction:column;align-items:center;gap:30px;opacity:0;animation:markIn .5s ease-out forwards}
.mark{width:156px;height:auto;display:block;animation:breathe 2.4s ease-in-out infinite}
.spinner{width:28px;height:28px;border-radius:50%;border:3px solid rgba(17,17,17,.14);border-top-color:#111111;animation:spin .8s linear infinite}
.launching .spinner{border-top-color:#3d3d3d;animation-duration:.45s}
.launching .mark{animation-duration:1.4s}
.reason{display:none;max-width:min(78vw,720px);color:#9a3412;font-size:14px;line-height:1.6;text-align:center;word-break:break-word}
.failed .spinner{display:none}
.failed .reason{display:block}
.failed .mark{animation:none;opacity:1}
@keyframes markIn{to{opacity:1}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.04)}}
</style></head>
<body class="__STAGE__"><div class="stage">__MARK__<div class="spinner" role="progressbar" aria-label="Loading"></div><p class="reason">__REASON__</p></div></body></html>"##;

fn startup_document(stage: &str) -> String {
    SPLASH_TEMPLATE
        .replace("__MARK__", SPLASH_MARK)
        .replace("__STAGE__", stage)
}

fn startup_data_url(stage: &str) -> String {
    let mut encoded = String::from("data:text/html;charset=utf-8,");
    for byte in startup_document(stage).bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char)
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

fn command_without_window(program: &str) -> std::process::Command {
    let mut command = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}
