use std::borrow::Cow;

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
fn save_resume(resume: String) -> Result<(), String> {
    write_text("resume.json", &resume)
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
            save_resume,
            save_provider,
            load_provider,
            ask_assistant
        ])
        .register_uri_scheme_protocol("fontcache", |_ctx, request| read_prepared_font(&request))
        .setup(|app| {
            let mut builder = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Reactive Resume")
            .inner_size(900.0, 980.0)
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
