use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub(crate) trait Clock {
    fn sleep(&mut self, duration: Duration);
}

pub(crate) trait StartupSurface {
    fn show_local(&mut self, status: &str);
    fn navigate(&mut self, url: &str);
}

pub(crate) trait BrowserHost {
    fn evergreen_installed(&mut self) -> bool;
    fn grant_read_execute(&mut self, folder: &Path) -> Result<(), String>;
    fn use_browser_folder(&mut self, folder: Option<&Path>);
}

pub(crate) struct ServerLaunch {
    pub node: PathBuf,
    pub script: PathBuf,
    pub current_dir: PathBuf,
    pub data_dir: PathBuf,
    pub web_dist: PathBuf,
    pub port: u16,
    pub legacy_sqlite: Option<PathBuf>,
}

pub(crate) trait ProcessHost {
    fn spawn_server(&mut self, launch: &ServerLaunch) -> Result<u32, String>;
    fn stop(&mut self, pid: u32);
}

pub(crate) struct PortableBoot<'a> {
    pub executable: &'a Path,
    pub app_data: &'a Path,
    pub port: u16,
    pub clock: &'a mut dyn Clock,
    pub surface: &'a mut dyn StartupSurface,
    pub browser: &'a mut dyn BrowserHost,
    pub processes: &'a mut dyn ProcessHost,
}

const TRAILER_LEN: u64 = 80;
const TRAILER_MAGIC: &[u8; 16] = b"RRPORTABLE!!!!!\n";
const POLL_INTERVAL: Duration = Duration::from_millis(100);
const HEALTH_DEADLINE: Duration = Duration::from_secs(180);

pub(crate) fn boot_portable(boot: &mut PortableBoot<'_>) -> Result<(), String> {
    match start_portable(boot) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = std::fs::create_dir_all(boot.app_data);
            let _ = std::fs::write(boot.app_data.join("boot.log"), &error);
            Err(error)
        }
    }
}

fn start_portable(boot: &mut PortableBoot<'_>) -> Result<(), String> {
    let (zip_len, _version) = read_trailer(boot.executable)?;
    if port_is_busy(boot.port) {
        return Err(format!("port {} is already in use", boot.port));
    }
    let manifest = read_component_manifest(boot.executable, zip_len)?;
    let runtime = boot.app_data.join("runtime");
    boot.surface.show_local("Preparing the runtime");
    prepare_browser(boot, zip_len, &manifest.webview2, &runtime)?;
    install_component(
        boot.executable,
        zip_len,
        "node",
        &manifest.node,
        &runtime.join("node"),
        node_ready,
        &format!(
            "bundled node is missing: {}",
            runtime.join("node").join("node.exe").display()
        ),
    )?;
    install_component(
        boot.executable,
        zip_len,
        "server",
        &manifest.server,
        &runtime.join("server"),
        server_ready,
        &format!(
            "desktop server is missing: {}",
            runtime.join("server").join("desktop-host.mjs").display()
        ),
    )?;
    install_component(
        boot.executable,
        zip_len,
        "web",
        &manifest.web,
        &runtime.join("web"),
        web_ready,
        "bundled web app is missing",
    )?;
    boot.surface.show_local("Starting the app");
    let server_dir = runtime.join("server");
    let data_dir = boot.app_data.join("data");
    std::fs::create_dir_all(&data_dir).map_err(|error| error.to_string())?;
    let pid = boot.processes.spawn_server(&ServerLaunch {
        node: runtime.join("node").join("node.exe"),
        script: server_dir.join("desktop-host.mjs"),
        current_dir: server_dir,
        data_dir,
        web_dist: runtime.join("web").join("dist"),
        port: boot.port,
        legacy_sqlite: legacy_sqlite(boot.executable),
    })?;
    if let Err(error) = wait_until_healthy(boot.port, boot.clock) {
        boot.processes.stop(pid);
        return Err(error);
    }
    boot.surface
        .navigate(&format!("http://127.0.0.1:{}/desktop/enter", boot.port));
    Ok(())
}

fn prepare_browser(
    boot: &mut PortableBoot<'_>,
    zip_len: u64,
    hash: &str,
    runtime: &Path,
) -> Result<(), String> {
    if boot.browser.evergreen_installed() {
        boot.browser.use_browser_folder(None);
        return Ok(());
    }
    let component = runtime.join("webview2");
    install_component(
        boot.executable,
        zip_len,
        "webview2",
        hash,
        &component,
        webview_ready,
        "bundled WebView2 is missing",
    )?;
    let record = runtime.join("browser.txt");
    let saved = std::fs::read_to_string(&record)
        .ok()
        .map(|text| PathBuf::from(text.trim()))
        .filter(|path| path.join("msedgewebview2.exe").is_file());
    let folder = if let Some(folder) = saved {
        folder
    } else {
        let executable = find_named(&component, "msedgewebview2.exe")
            .ok_or_else(|| "bundled WebView2 is missing".to_string())?;
        let folder = executable
            .parent()
            .ok_or_else(|| "bundled WebView2 is missing".to_string())?
            .to_path_buf();
        let text = folder
            .to_str()
            .ok_or_else(|| "bundled WebView2 path is not unicode".to_string())?;
        std::fs::create_dir_all(runtime).map_err(|error| error.to_string())?;
        std::fs::write(&record, text).map_err(|error| error.to_string())?;
        folder
    };
    let folder_text = folder
        .to_str()
        .ok_or_else(|| "bundled WebView2 path is not unicode".to_string())?
        .to_string();
    let grant_record = runtime.join("browser.granted");
    let already_granted = std::fs::read_to_string(&grant_record)
        .ok()
        .is_some_and(|text| text.trim() == folder_text);
    if !already_granted {
        boot.browser.grant_read_execute(&folder)?;
        std::fs::write(&grant_record, &folder_text).map_err(|error| error.to_string())?;
    }
    boot.browser.use_browser_folder(Some(&folder));
    Ok(())
}

fn legacy_sqlite(executable: &Path) -> Option<PathBuf> {
    let sqlite = executable
        .parent()?
        .join("desktop-data")
        .join("resumes.sqlite");
    sqlite.is_file().then_some(sqlite)
}

fn port_is_busy(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_err()
}

fn wait_until_healthy(port: u16, clock: &mut dyn Clock) -> Result<(), String> {
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_millis(500))
        .build();
    let url = format!("http://127.0.0.1:{port}/api/health");
    let mut waited = Duration::ZERO;
    while waited < HEALTH_DEADLINE {
        if agent.get(&url).call().is_ok() {
            return Ok(());
        }
        clock.sleep(POLL_INTERVAL);
        waited += POLL_INTERVAL;
    }
    Err("desktop server did not become healthy".to_string())
}

#[derive(serde::Deserialize)]
struct Manifest {
    node: String,
    server: String,
    web: String,
    webview2: String,
}

fn node_ready(directory: &Path) -> bool {
    directory.join("node.exe").is_file()
}

fn server_ready(directory: &Path) -> bool {
    directory.join("desktop-host.mjs").is_file()
}

fn web_ready(directory: &Path) -> bool {
    directory.join("dist").join("index.html").is_file()
}

fn webview_ready(directory: &Path) -> bool {
    find_named(directory, "msedgewebview2.exe").is_some()
}

fn install_component(
    executable: &Path,
    zip_len: u64,
    name: &str,
    hash: &str,
    destination: &Path,
    ready: fn(&Path) -> bool,
    missing: &str,
) -> Result<(), String> {
    if let Ok(stored) = std::fs::read_to_string(destination.join(".complete")) {
        if stored.trim() == hash
            && ready(destination)
            && component_files_present(executable, zip_len, name, destination)
        {
            return Ok(());
        }
    }
    if destination.exists() {
        std::fs::remove_dir_all(extended_path(destination)).map_err(|error| error.to_string())?;
    }
    extract_component(executable, zip_len, name, destination)?;
    if !ready(destination) {
        return Err(missing.to_string());
    }
    std::fs::write(destination.join(".complete"), hash).map_err(|error| error.to_string())
}

fn component_files_present(
    executable: &Path,
    zip_len: u64,
    name: &str,
    destination: &Path,
) -> bool {
    let Ok(range) = open_range(executable, zip_len) else {
        return false;
    };
    let Ok(mut archive) = zip::ZipArchive::new(range) else {
        return false;
    };
    let prefix = format!("{name}/");
    for index in 0..archive.len() {
        let Ok(entry) = archive.by_index(index) else {
            return false;
        };
        let entry_name = entry.name().replace('\\', "/");
        let Some(relative) = entry_name.strip_prefix(&prefix) else {
            continue;
        };
        if relative.is_empty() || entry.is_dir() {
            continue;
        }
        let Ok(Some(relative_path)) = safe_zip_path(relative) else {
            return false;
        };
        if !destination.join(relative_path).is_file() {
            return false;
        }
    }
    true
}

fn find_named(directory: &Path, file_name: &str) -> Option<PathBuf> {
    let mut pending = vec![directory.to_path_buf()];
    while let Some(current) = pending.pop() {
        let entries = match std::fs::read_dir(&current) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
                continue;
            }
            if path.file_name().and_then(|name| name.to_str()) == Some(file_name) {
                return Some(path);
            }
        }
    }
    None
}

fn read_component_manifest(executable: &Path, zip_len: u64) -> Result<Manifest, String> {
    let mut archive = zip::ZipArchive::new(open_range(executable, zip_len)?)
        .map_err(|error| error.to_string())?;
    let mut entry = archive
        .by_name("manifest.json")
        .map_err(|_| "portable runtime trailer is invalid".to_string())?;
    let mut text = String::new();
    entry
        .read_to_string(&mut text)
        .map_err(|error| error.to_string())?;
    serde_json::from_str(&text).map_err(|_| "portable runtime trailer is invalid".to_string())
}

fn read_trailer(executable: &Path) -> Result<(u64, String), String> {
    let mut file = std::fs::File::open(executable).map_err(|error| error.to_string())?;
    let length = file.metadata().map_err(|error| error.to_string())?.len();
    if length < TRAILER_LEN {
        return Err("this executable has no portable runtime".to_string());
    }
    file.seek(SeekFrom::End(-(TRAILER_LEN as i64)))
        .map_err(|error| error.to_string())?;
    let mut trailer = [0_u8; TRAILER_LEN as usize];
    file.read_exact(&mut trailer)
        .map_err(|error| error.to_string())?;
    if trailer[0..16] != TRAILER_MAGIC[..] {
        return Err("this executable has no portable runtime".to_string());
    }
    let mut zip_len_bytes = [0_u8; 8];
    zip_len_bytes.copy_from_slice(&trailer[16..24]);
    let zip_len = u64::from_le_bytes(zip_len_bytes);
    if zip_len == 0 || zip_len + TRAILER_LEN > length {
        return Err("portable runtime trailer is invalid".to_string());
    }
    let version_end = trailer[24..]
        .iter()
        .position(|byte| *byte == 0)
        .map(|index| 24 + index)
        .unwrap_or(TRAILER_LEN as usize);
    let version =
        std::str::from_utf8(&trailer[24..version_end]).map_err(|error| error.to_string())?;
    if version.is_empty()
        || !version
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
    {
        return Err("portable runtime version is invalid".to_string());
    }
    Ok((zip_len, version.to_string()))
}

struct FileRange {
    file: std::fs::File,
    start: u64,
    len: u64,
    pos: u64,
}

impl Read for FileRange {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if self.pos >= self.len {
            return Ok(0);
        }
        let available = std::cmp::min(buffer.len() as u64, self.len - self.pos) as usize;
        self.file.seek(SeekFrom::Start(self.start + self.pos))?;
        let read = self.file.read(&mut buffer[..available])?;
        self.pos += read as u64;
        Ok(read)
    }
}

impl Seek for FileRange {
    fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
        let next = match position {
            SeekFrom::Start(offset) => offset as i64,
            SeekFrom::End(offset) => self.len as i64 + offset,
            SeekFrom::Current(offset) => self.pos as i64 + offset,
        };
        if next < 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "seek before the start of the portable runtime",
            ));
        }
        self.pos = next as u64;
        Ok(self.pos)
    }
}

fn open_range(executable: &Path, zip_len: u64) -> Result<FileRange, String> {
    let file = std::fs::File::open(executable).map_err(|error| error.to_string())?;
    let length = file.metadata().map_err(|error| error.to_string())?.len();
    Ok(FileRange {
        file,
        start: length - TRAILER_LEN - zip_len,
        len: zip_len,
        pos: 0,
    })
}

fn extract_component(
    executable: &Path,
    zip_len: u64,
    name: &str,
    destination: &Path,
) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(open_range(executable, zip_len)?)
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(extended_path(destination)).map_err(|error| error.to_string())?;
    let prefix = format!("{name}/");
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
        let entry_name = entry.name().replace('\\', "/");
        let Some(relative) = entry_name.strip_prefix(&prefix) else {
            continue;
        };
        if relative.is_empty() {
            continue;
        }
        let Some(relative_path) = safe_zip_path(relative)? else {
            continue;
        };
        let path = destination.join(relative_path);
        let target = extended_path(&path);
        if entry.is_dir() || entry_name.ends_with('/') {
            std::fs::create_dir_all(&target).map_err(|error| error.to_string())?;
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut output = std::fs::File::create(&target).map_err(|error| error.to_string())?;
        std::io::copy(&mut entry, &mut output).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn safe_zip_path(name: &str) -> Result<Option<PathBuf>, String> {
    let mut normalized = name.replace('\\', "/");
    while normalized.starts_with("./") {
        normalized = normalized[2..].to_string();
    }
    if normalized == "." || normalized.is_empty() {
        return Ok(None);
    }
    if normalized.starts_with('/') || normalized.split('/').any(|part| part == "..") {
        return Err(format!("unsafe zip entry {name}"));
    }
    Ok(Some(PathBuf::from(normalized)))
}

fn extended_path(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    let text = absolute.to_string_lossy().replace('/', "\\");
    if text.starts_with(r"\\?\") {
        return PathBuf::from(text.as_str());
    }
    PathBuf::from(format!(r"\\?\{text}"))
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use tiny_http::{Response, Server, StatusCode};

    use super::*;

    struct FakeClock {
        sleeps: Vec<Duration>,
    }

    impl Clock for FakeClock {
        fn sleep(&mut self, duration: Duration) {
            self.sleeps.push(duration);
        }
    }

    struct RecordingSurface {
        events: Arc<Mutex<Vec<String>>>,
        node_exe: PathBuf,
    }

    impl StartupSurface for RecordingSurface {
        fn show_local(&mut self, status: &str) {
            let extracted = self.node_exe.is_file();
            self.events
                .lock()
                .expect("events")
                .push(format!("show:{status}:node={extracted}"));
        }

        fn navigate(&mut self, url: &str) {
            self.events
                .lock()
                .expect("events")
                .push(format!("navigate:{url}"));
        }
    }

    struct InstalledBrowser {
        evergreen: bool,
        grant_error: bool,
        grants: Vec<PathBuf>,
        folders: Vec<Option<PathBuf>>,
    }

    impl InstalledBrowser {
        fn system() -> Self {
            Self {
                evergreen: true,
                grant_error: false,
                grants: Vec::new(),
                folders: Vec::new(),
            }
        }
    }

    impl BrowserHost for InstalledBrowser {
        fn evergreen_installed(&mut self) -> bool {
            self.evergreen
        }

        fn grant_read_execute(&mut self, folder: &Path) -> Result<(), String> {
            self.grants.push(folder.to_path_buf());
            if self.grant_error {
                Err("could not grant WebView2 permissions".to_string())
            } else {
                Ok(())
            }
        }

        fn use_browser_folder(&mut self, folder: Option<&Path>) {
            self.folders.push(folder.map(Path::to_path_buf));
        }
    }

    struct HealthServer {
        events: Arc<Mutex<Vec<String>>>,
        port: u16,
        unhealthy_before_ok: usize,
        polls: Arc<AtomicUsize>,
        stopped: Arc<Mutex<Vec<u32>>>,
    }

    impl ProcessHost for HealthServer {
        fn spawn_server(&mut self, launch: &ServerLaunch) -> Result<u32, String> {
            assert_eq!(launch.port, self.port);
            assert!(launch.node.is_file());
            assert!(launch.script.is_file());
            assert_eq!(
                launch.current_dir.as_path(),
                launch.script.parent().expect("server dir")
            );
            assert!(launch.data_dir.is_dir());
            assert!(launch.web_dist.join("index.html").is_file());
            assert!(launch.legacy_sqlite.is_none());
            self.events
                .lock()
                .expect("events")
                .push("spawn".to_string());
            let polls = Arc::clone(&self.polls);
            let unhealthy_before_ok = self.unhealthy_before_ok;
            let server = Server::http(format!("127.0.0.1:{}", self.port)).expect("health stub");
            std::thread::spawn(move || {
                for mut request in server.incoming_requests() {
                    let _ = request.as_reader().read_to_end(&mut Vec::new());
                    let seen = polls.fetch_add(1, Ordering::SeqCst);
                    let status = if seen < unhealthy_before_ok { 503 } else { 200 };
                    let _ = request.respond(Response::empty(StatusCode(status)));
                }
            });
            Ok(77)
        }

        fn stop(&mut self, pid: u32) {
            self.stopped.lock().expect("stopped").push(pid);
        }
    }

    struct Fixture {
        root: PathBuf,
        port: u16,
    }

    impl Fixture {
        fn new() -> Self {
            let port = std::net::TcpListener::bind("127.0.0.1:0")
                .expect("port")
                .local_addr()
                .expect("addr")
                .port();
            let root = std::env::temp_dir().join(format!(
                "rr-portable-{}-{}-{}",
                std::process::id(),
                port,
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|duration| duration.as_nanos())
                    .unwrap_or(0)
            ));
            std::fs::create_dir_all(root.join("app")).expect("app data");
            Self { root, port }
        }

        fn exe(&self) -> PathBuf {
            self.root.join("Reactive Resume.exe")
        }

        fn app_data(&self) -> PathBuf {
            self.root.join("app")
        }

        fn node_exe(&self) -> PathBuf {
            self.app_data()
                .join("runtime")
                .join("node")
                .join("node.exe")
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn write_portable(path: &Path, files: &[(&str, &[u8])]) {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for (name, bytes) in files {
            zip.start_file(*name, options).expect("zip entry");
            zip.write_all(bytes).expect("zip bytes");
        }
        let cursor = zip.finish().expect("zip");
        let payload = cursor.into_inner();
        let mut trailer = Vec::new();
        trailer.extend_from_slice(b"RRPORTABLE!!!!!\n");
        trailer.extend_from_slice(&(payload.len() as u64).to_le_bytes());
        let mut version = [0_u8; 56];
        version[..8].copy_from_slice(b"runtime1");
        trailer.extend_from_slice(&version);
        let mut exe = std::fs::File::create(path).expect("exe");
        exe.write_all(b"MZ-fake-exe").expect("prefix");
        exe.write_all(&payload).expect("payload");
        exe.write_all(&trailer).expect("trailer");
    }

    fn standard_payload() -> Vec<(&'static str, &'static [u8])> {
        vec![
            (
                "manifest.json",
                br#"{"node":"node-hash-1","server":"server-hash-1","web":"web-hash-1","webview2":"webview-hash-1"}"#,
            ),
            ("node/node.exe", b"node-bytes"),
            ("server/desktop-host.mjs", b"server-bytes"),
            ("web/dist/index.html", b"web-bytes"),
            ("webview2/Fixed/msedgewebview2.exe", b"webview-bytes"),
        ]
    }

    #[test]
    fn startup_page_is_local_and_opens_desktop_enter_only_after_the_server_is_healthy() {
        let fixture = Fixture::new();
        let payload = standard_payload();
        write_portable(&fixture.exe(), &payload);
        let events = Arc::new(Mutex::new(Vec::new()));
        let mut clock = FakeClock { sleeps: Vec::new() };
        let mut surface = RecordingSurface {
            events: Arc::clone(&events),
            node_exe: fixture.node_exe(),
        };
        let mut browser = InstalledBrowser::system();
        let mut processes = HealthServer {
            events: Arc::clone(&events),
            port: fixture.port,
            unhealthy_before_ok: 1,
            polls: Arc::new(AtomicUsize::new(0)),
            stopped: Arc::new(Mutex::new(Vec::new())),
        };
        let exe = fixture.exe();
        let app_data = fixture.app_data();
        let mut boot = PortableBoot {
            executable: &exe,
            app_data: &app_data,
            port: fixture.port,
            clock: &mut clock,
            surface: &mut surface,
            browser: &mut browser,
            processes: &mut processes,
        };

        boot_portable(&mut boot).expect("boot");

        assert_eq!(
            events.lock().expect("events").clone(),
            vec![
                "show:Preparing the runtime:node=false".to_string(),
                "show:Starting the app:node=true".to_string(),
                "spawn".to_string(),
                format!("navigate:http://127.0.0.1:{}/desktop/enter", fixture.port),
            ]
        );
        assert_eq!(clock.sleeps, vec![Duration::from_millis(100)]);
        assert!(!app_data.join("locales").exists());
    }

    #[test]
    fn unchanged_components_are_not_rewritten() {
        let fixture = Fixture::new();
        let payload = standard_payload();
        write_portable(&fixture.exe(), &payload);
        boot_once(&fixture, fixture.port, true, 0).expect("first boot");
        std::fs::write(fixture.node_exe(), b"touched").expect("touch node");
        let node_extra = fixture
            .app_data()
            .join("runtime")
            .join("node")
            .join("EXTRA.txt");
        let server_extra = fixture
            .app_data()
            .join("runtime")
            .join("server")
            .join("EXTRA.txt");
        let web_extra = fixture
            .app_data()
            .join("runtime")
            .join("web")
            .join("EXTRA.txt");
        std::fs::write(&node_extra, b"keep-node").expect("node extra");
        std::fs::write(&server_extra, b"keep-server").expect("server extra");
        std::fs::write(&web_extra, b"keep-web").expect("web extra");

        let port = free_port();
        boot_once(&fixture, port, true, 0).expect("second boot");

        assert_eq!(std::fs::read(fixture.node_exe()).expect("node"), b"touched");
        assert_eq!(std::fs::read(node_extra).expect("node extra"), b"keep-node");
        assert_eq!(
            std::fs::read(server_extra).expect("server extra"),
            b"keep-server"
        );
        assert_eq!(std::fs::read(web_extra).expect("web extra"), b"keep-web");
    }

    fn free_port() -> u16 {
        std::net::TcpListener::bind("127.0.0.1:0")
            .expect("port")
            .local_addr()
            .expect("addr")
            .port()
    }

    struct BootReport {
        result: Result<(), String>,
        events: Vec<String>,
        sleeps: Vec<Duration>,
        grants: Vec<PathBuf>,
        folders: Vec<Option<PathBuf>>,
        stopped: Vec<u32>,
    }

    fn boot_once(
        fixture: &Fixture,
        port: u16,
        evergreen: bool,
        unhealthy_before_ok: usize,
    ) -> Result<(), String> {
        run_boot(
            fixture,
            port,
            InstalledBrowser {
                evergreen,
                grant_error: false,
                grants: Vec::new(),
                folders: Vec::new(),
            },
            unhealthy_before_ok,
        )
        .result
    }

    fn run_boot(
        fixture: &Fixture,
        port: u16,
        mut browser: InstalledBrowser,
        unhealthy_before_ok: usize,
    ) -> BootReport {
        let events = Arc::new(Mutex::new(Vec::new()));
        let stopped = Arc::new(Mutex::new(Vec::new()));
        let mut clock = FakeClock { sleeps: Vec::new() };
        let mut surface = RecordingSurface {
            events: Arc::clone(&events),
            node_exe: fixture.node_exe(),
        };
        let mut processes = HealthServer {
            events: Arc::clone(&events),
            port,
            unhealthy_before_ok,
            polls: Arc::new(AtomicUsize::new(0)),
            stopped: Arc::clone(&stopped),
        };
        let exe = fixture.exe();
        let app_data = fixture.app_data();
        let mut boot = PortableBoot {
            executable: &exe,
            app_data: &app_data,
            port,
            clock: &mut clock,
            surface: &mut surface,
            browser: &mut browser,
            processes: &mut processes,
        };
        let result = boot_portable(&mut boot);
        let events = events.lock().expect("events").clone();
        let stopped = stopped.lock().expect("stopped").clone();
        BootReport {
            result,
            events,
            sleeps: clock.sleeps,
            grants: browser.grants,
            folders: browser.folders,
            stopped,
        }
    }

    fn component_manifest(node: &str, server: &str, web: &str, webview: &str) -> String {
        format!(r#"{{"node":"{node}","server":"{server}","web":"{web}","webview2":"{webview}"}}"#)
    }

    fn write_payload(
        path: &Path,
        manifest_text: &str,
        node: &[u8],
        server: &[u8],
        web: &[u8],
        webview: &[u8],
    ) {
        let files = [
            ("manifest.json", manifest_text.as_bytes()),
            ("node/node.exe", node),
            ("server/desktop-host.mjs", server),
            ("web/dist/index.html", web),
            ("webview2/Fixed/msedgewebview2.exe", webview),
        ];
        write_portable(path, &files);
    }

    #[test]
    fn only_the_changed_component_is_replaced() {
        let fixture = Fixture::new();
        write_portable(&fixture.exe(), &standard_payload());
        boot_once(&fixture, fixture.port, true, 0).expect("first boot");
        let server_extra = fixture
            .app_data()
            .join("runtime")
            .join("server")
            .join("EXTRA.txt");
        let web_extra = fixture
            .app_data()
            .join("runtime")
            .join("web")
            .join("EXTRA.txt");
        std::fs::write(&server_extra, b"keep-server").unwrap();
        std::fs::write(&web_extra, b"keep-web").unwrap();
        let manifest = component_manifest(
            "node-hash-2",
            "server-hash-1",
            "web-hash-1",
            "webview-hash-1",
        );
        write_payload(
            &fixture.exe(),
            &manifest,
            b"node-v2",
            b"server-bytes",
            b"web-bytes",
            b"webview-bytes",
        );
        boot_once(&fixture, free_port(), true, 0).expect("second boot");
        assert_eq!(std::fs::read(fixture.node_exe()).unwrap(), b"node-v2");
        assert_eq!(
            std::fs::read(
                fixture
                    .app_data()
                    .join("runtime")
                    .join("node")
                    .join(".complete")
            )
            .unwrap(),
            b"node-hash-2"
        );
        assert_eq!(std::fs::read(&server_extra).unwrap(), b"keep-server");
        assert_eq!(std::fs::read(&web_extra).unwrap(), b"keep-web");
        assert_eq!(
            std::fs::read(
                fixture
                    .app_data()
                    .join("runtime")
                    .join("server")
                    .join(".complete")
            )
            .unwrap(),
            b"server-hash-1"
        );
    }

    #[test]
    fn only_the_changed_server_or_web_component_is_replaced() {
        let fixture = Fixture::new();
        write_portable(&fixture.exe(), &standard_payload());
        boot_once(&fixture, fixture.port, true, 0).expect("first boot");
        let node_extra = fixture
            .app_data()
            .join("runtime")
            .join("node")
            .join("EXTRA.txt");
        std::fs::write(&node_extra, b"keep-node").unwrap();
        let manifest = component_manifest(
            "node-hash-1",
            "server-hash-2",
            "web-hash-1",
            "webview-hash-1",
        );
        write_payload(
            &fixture.exe(),
            &manifest,
            b"node-bytes",
            b"server-v2",
            b"web-bytes",
            b"webview-bytes",
        );
        boot_once(&fixture, free_port(), true, 0).expect("server update");
        assert_eq!(
            std::fs::read(
                fixture
                    .app_data()
                    .join("runtime")
                    .join("server")
                    .join("desktop-host.mjs")
            )
            .unwrap(),
            b"server-v2"
        );
        assert_eq!(std::fs::read(&node_extra).unwrap(), b"keep-node");

        let web_manifest = component_manifest(
            "node-hash-1",
            "server-hash-2",
            "web-hash-2",
            "webview-hash-1",
        );
        write_payload(
            &fixture.exe(),
            &web_manifest,
            b"node-bytes",
            b"server-v2",
            b"web-v2",
            b"webview-bytes",
        );
        boot_once(&fixture, free_port(), true, 0).expect("web update");
        assert_eq!(
            std::fs::read(
                fixture
                    .app_data()
                    .join("runtime")
                    .join("web")
                    .join("dist")
                    .join("index.html")
            )
            .unwrap(),
            b"web-v2"
        );
        assert_eq!(std::fs::read(&node_extra).unwrap(), b"keep-node");
        assert_eq!(
            std::fs::read(
                fixture
                    .app_data()
                    .join("runtime")
                    .join("server")
                    .join("desktop-host.mjs")
            )
            .unwrap(),
            b"server-v2"
        );
    }

    #[test]
    fn an_incomplete_component_is_cleared_and_extracted_again() {
        let fixture = Fixture::new();
        write_portable(&fixture.exe(), &standard_payload());
        boot_once(&fixture, fixture.port, true, 0).expect("first boot");
        let node = fixture.app_data().join("runtime").join("node");
        std::fs::remove_file(node.join(".complete")).unwrap();
        std::fs::write(node.join("PARTIAL.bin"), b"partial").unwrap();
        boot_once(&fixture, free_port(), true, 0).expect("missing marker");
        assert!(!node.join("PARTIAL.bin").exists());
        assert_eq!(std::fs::read(fixture.node_exe()).unwrap(), b"node-bytes");
        assert_eq!(
            std::fs::read(node.join(".complete")).unwrap(),
            b"node-hash-1"
        );

        std::fs::remove_file(fixture.node_exe()).unwrap();
        std::fs::write(node.join("EXTRA.txt"), b"stale").unwrap();
        boot_once(&fixture, free_port(), true, 0).expect("missing file");
        assert!(!node.join("EXTRA.txt").exists());
        assert_eq!(std::fs::read(fixture.node_exe()).unwrap(), b"node-bytes");
        assert_eq!(
            std::fs::read(node.join(".complete")).unwrap(),
            b"node-hash-1"
        );

        let mut payload = standard_payload();
        payload.push(("node/license.txt", b"license"));
        write_portable(&fixture.exe(), &payload);
        boot_once(&fixture, free_port(), true, 0).expect("payload with license");
        std::fs::remove_file(node.join("license.txt")).unwrap();
        boot_once(&fixture, free_port(), true, 0).expect("missing license");
        assert_eq!(std::fs::read(node.join("license.txt")).unwrap(), b"license");
    }

    #[test]
    fn a_failed_extract_does_not_write_a_completion_marker() {
        let fixture = Fixture::new();
        let manifest = component_manifest(
            "node-hash-1",
            "server-hash-1",
            "web-hash-1",
            "webview-hash-1",
        );
        let files = [
            ("manifest.json", manifest.as_bytes()),
            ("node/node.exe", &b"node-bytes"[..]),
            ("node/../escape.txt", &b"nope"[..]),
            ("server/desktop-host.mjs", &b"server-bytes"[..]),
            ("web/dist/index.html", &b"web-bytes"[..]),
            ("webview2/Fixed/msedgewebview2.exe", &b"webview-bytes"[..]),
        ];
        write_portable(&fixture.exe(), &files);
        let report = run_boot(&fixture, fixture.port, InstalledBrowser::system(), 0);
        assert!(report.result.is_err());
        assert!(report
            .events
            .iter()
            .all(|event| !event.starts_with("navigate:")));
        assert!(!fixture
            .app_data()
            .join("runtime")
            .join("node")
            .join(".complete")
            .exists());
        assert!(!fixture
            .app_data()
            .join("runtime")
            .join("server")
            .join(".complete")
            .exists());
        assert!(!fixture
            .app_data()
            .join("runtime")
            .join("escape.txt")
            .exists());
        let log = std::fs::read_to_string(fixture.app_data().join("boot.log")).unwrap();
        assert_eq!(log, report.result.unwrap_err());
    }

    #[test]
    fn component_updates_keep_saved_resumes_and_old_runtime_directories() {
        let fixture = Fixture::new();
        write_portable(&fixture.exe(), &standard_payload());
        boot_once(&fixture, fixture.port, true, 0).expect("first boot");
        let resume = fixture.app_data().join("data").join("resume.txt");
        let old = fixture
            .app_data()
            .join("runtime")
            .join("old-version")
            .join("keep.txt");
        std::fs::create_dir_all(old.parent().unwrap()).unwrap();
        std::fs::write(&resume, b"saved-resume").unwrap();
        std::fs::write(&old, b"old-runtime").unwrap();
        let manifest = component_manifest(
            "node-hash-2",
            "server-hash-1",
            "web-hash-1",
            "webview-hash-1",
        );
        write_payload(
            &fixture.exe(),
            &manifest,
            b"node-v2",
            b"server-bytes",
            b"web-bytes",
            b"webview-bytes",
        );
        boot_once(&fixture, free_port(), true, 0).expect("second boot");
        assert_eq!(std::fs::read(resume).unwrap(), b"saved-resume");
        assert_eq!(std::fs::read(old).unwrap(), b"old-runtime");
        assert_eq!(std::fs::read(fixture.node_exe()).unwrap(), b"node-v2");
    }

    #[test]
    fn a_busy_port_fails_before_extract_or_the_health_wait() {
        let fixture = Fixture::new();
        write_portable(&fixture.exe(), &standard_payload());
        let _listener = std::net::TcpListener::bind(("127.0.0.1", fixture.port)).unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let mut clock = FakeClock { sleeps: Vec::new() };
        let mut surface = RecordingSurface {
            events: Arc::clone(&events),
            node_exe: fixture.node_exe(),
        };
        let mut browser = InstalledBrowser::system();
        let mut processes = IdleProcess;
        let exe = fixture.exe();
        let app_data = fixture.app_data();
        let mut boot = PortableBoot {
            executable: &exe,
            app_data: &app_data,
            port: fixture.port,
            clock: &mut clock,
            surface: &mut surface,
            browser: &mut browser,
            processes: &mut processes,
        };
        let error = boot_portable(&mut boot).expect_err("busy port");
        assert_eq!(error, format!("port {} is already in use", fixture.port));
        assert!(events.lock().unwrap().is_empty());
        assert!(clock.sleeps.is_empty());
        assert!(!fixture.node_exe().exists());
        assert_eq!(
            std::fs::read_to_string(app_data.join("boot.log")).unwrap(),
            error
        );
    }

    struct IdleProcess;

    impl ProcessHost for IdleProcess {
        fn spawn_server(&mut self, _launch: &ServerLaunch) -> Result<u32, String> {
            panic!("server spawned while the port was busy");
        }

        fn stop(&mut self, _pid: u32) {
            panic!("server stopped while the port was busy");
        }
    }

    #[test]
    fn health_polling_waits_a_tenth_of_a_second_and_stops_the_server_at_the_deadline() {
        let fixture = Fixture::new();
        write_portable(&fixture.exe(), &standard_payload());
        let report = run_boot(
            &fixture,
            fixture.port,
            InstalledBrowser::system(),
            usize::MAX,
        );
        assert_eq!(report.stopped, vec![77]);
        assert_eq!(report.sleeps.len(), 1800);
        assert!(report
            .sleeps
            .iter()
            .all(|sleep| *sleep == Duration::from_millis(100)));
        assert!(report
            .events
            .iter()
            .all(|event| !event.starts_with("navigate:")));
        let error = report.result.expect_err("timeout");
        assert_eq!(error, "desktop server did not become healthy");
        assert_eq!(
            std::fs::read_to_string(fixture.app_data().join("boot.log")).unwrap(),
            error
        );
    }

    #[test]
    fn a_missing_or_invalid_trailer_is_logged_without_a_completion_marker() {
        let missing = Fixture::new();
        std::fs::write(missing.exe(), b"not-a-portable-exe").unwrap();
        let missing_report = run_boot(&missing, missing.port, InstalledBrowser::system(), 0);
        assert_eq!(
            missing_report.result.expect_err("missing"),
            "this executable has no portable runtime"
        );
        assert_eq!(
            std::fs::read_to_string(missing.app_data().join("boot.log")).unwrap(),
            "this executable has no portable runtime"
        );
        assert!(!missing
            .app_data()
            .join("runtime")
            .join("node")
            .join(".complete")
            .exists());

        let invalid = Fixture::new();
        let mut trailer = Vec::new();
        trailer.extend_from_slice(b"RRPORTABLE!!!!!\n");
        trailer.extend_from_slice(&999_999_u64.to_le_bytes());
        trailer.extend_from_slice(&[0_u8; 56]);
        trailer[24..32].copy_from_slice(b"runtime1");
        std::fs::write(invalid.exe(), trailer).unwrap();
        let invalid_report = run_boot(&invalid, invalid.port, InstalledBrowser::system(), 0);
        assert_eq!(
            invalid_report.result.expect_err("invalid"),
            "portable runtime trailer is invalid"
        );
        assert!(!invalid
            .app_data()
            .join("runtime")
            .join("node")
            .join(".complete")
            .exists());
        assert_eq!(
            std::fs::read_to_string(invalid.app_data().join("boot.log")).unwrap(),
            "portable runtime trailer is invalid"
        );
    }

    #[test]
    fn evergreen_webview_does_not_use_or_prepare_the_bundled_runtime() {
        let fixture = Fixture::new();
        write_portable(&fixture.exe(), &standard_payload());
        let report = run_boot(&fixture, fixture.port, InstalledBrowser::system(), 0);
        report.result.expect("boot");
        assert!(report.grants.is_empty());
        assert_eq!(report.folders, vec![None]);
        assert!(!fixture.app_data().join("runtime").join("webview2").exists());
        assert!(fixture.node_exe().is_file());
    }

    #[test]
    fn bundled_webview_is_used_when_the_system_runtime_is_absent() {
        let fixture = Fixture::new();
        write_portable(&fixture.exe(), &standard_payload());
        let browser = InstalledBrowser {
            evergreen: false,
            grant_error: false,
            grants: Vec::new(),
            folders: Vec::new(),
        };
        let report = run_boot(&fixture, fixture.port, browser, 0);
        report.result.expect("boot");
        let folder = fixture
            .app_data()
            .join("runtime")
            .join("webview2")
            .join("Fixed");
        assert_eq!(report.grants, vec![folder.clone()]);
        assert_eq!(report.folders, vec![Some(folder.clone())]);
        assert!(folder.join("msedgewebview2.exe").is_file());
        assert_eq!(
            std::fs::read_to_string(fixture.app_data().join("runtime").join("browser.txt"))
                .unwrap(),
            folder.to_str().unwrap()
        );
        assert_eq!(
            std::fs::read_to_string(fixture.app_data().join("runtime").join("browser.granted"))
                .unwrap(),
            folder.to_str().unwrap()
        );

        let again = run_boot(
            &fixture,
            free_port(),
            InstalledBrowser {
                evergreen: false,
                grant_error: false,
                grants: Vec::new(),
                folders: Vec::new(),
            },
            0,
        );
        again.result.expect("second boot");
        assert!(again.grants.is_empty());
        assert_eq!(again.folders, vec![Some(folder)]);
    }

    #[test]
    fn a_saved_browser_directory_is_reused_until_it_is_invalid() {
        let fixture = Fixture::new();
        write_portable(&fixture.exe(), &standard_payload());
        run_boot(
            &fixture,
            fixture.port,
            InstalledBrowser {
                evergreen: false,
                grant_error: false,
                grants: Vec::new(),
                folders: Vec::new(),
            },
            0,
        )
        .result
        .expect("first boot");
        let elsewhere = fixture.app_data().join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::copy(
            fixture
                .app_data()
                .join("runtime")
                .join("webview2")
                .join("Fixed")
                .join("msedgewebview2.exe"),
            elsewhere.join("msedgewebview2.exe"),
        )
        .unwrap();
        std::fs::write(
            fixture.app_data().join("runtime").join("browser.txt"),
            elsewhere.to_str().unwrap(),
        )
        .unwrap();
        std::fs::write(
            fixture.app_data().join("runtime").join("browser.granted"),
            elsewhere.to_str().unwrap(),
        )
        .unwrap();
        let reused = run_boot(
            &fixture,
            free_port(),
            InstalledBrowser {
                evergreen: false,
                grant_error: false,
                grants: Vec::new(),
                folders: Vec::new(),
            },
            0,
        );
        reused.result.expect("reused record");
        assert!(reused.grants.is_empty());
        assert_eq!(reused.folders, vec![Some(elsewhere.clone())]);

        let bundled = fixture
            .app_data()
            .join("runtime")
            .join("webview2")
            .join("Fixed");
        std::fs::write(
            fixture.app_data().join("runtime").join("browser.granted"),
            bundled.to_str().unwrap(),
        )
        .unwrap();
        std::fs::write(
            fixture.app_data().join("runtime").join("browser.txt"),
            r"C:\missing\webview",
        )
        .unwrap();
        let resolved = run_boot(
            &fixture,
            free_port(),
            InstalledBrowser {
                evergreen: false,
                grant_error: false,
                grants: Vec::new(),
                folders: Vec::new(),
            },
            0,
        );
        resolved.result.expect("resolved again");
        let folder = fixture
            .app_data()
            .join("runtime")
            .join("webview2")
            .join("Fixed");
        assert_eq!(resolved.folders, vec![Some(folder.clone())]);
        assert!(resolved.grants.is_empty());
        assert_eq!(
            std::fs::read_to_string(fixture.app_data().join("runtime").join("browser.txt"))
                .unwrap(),
            folder.to_str().unwrap()
        );
    }

    #[test]
    fn grant_failure_is_logged_and_a_missing_bundled_browser_is_logged() {
        let denied = Fixture::new();
        write_portable(&denied.exe(), &standard_payload());
        let denied_report = run_boot(
            &denied,
            denied.port,
            InstalledBrowser {
                evergreen: false,
                grant_error: true,
                grants: Vec::new(),
                folders: Vec::new(),
            },
            0,
        );
        let denied_error = denied_report.result.expect_err("grant");
        assert_eq!(denied_error, "could not grant WebView2 permissions");
        assert_eq!(
            std::fs::read_to_string(denied.app_data().join("boot.log")).unwrap(),
            denied_error
        );
        assert!(!denied
            .app_data()
            .join("runtime")
            .join("browser.granted")
            .exists());
        assert!(denied_report
            .events
            .iter()
            .all(|event| !event.starts_with("navigate:")));

        let missing = Fixture::new();
        let manifest = component_manifest(
            "node-hash-1",
            "server-hash-1",
            "web-hash-1",
            "webview-hash-1",
        );
        let files = [
            ("manifest.json", manifest.as_bytes()),
            ("node/node.exe", &b"node-bytes"[..]),
            ("server/desktop-host.mjs", &b"server-bytes"[..]),
            ("web/dist/index.html", &b"web-bytes"[..]),
            ("webview2/readme.txt", &b"no-browser"[..]),
        ];
        write_portable(&missing.exe(), &files);
        let missing_report = run_boot(
            &missing,
            missing.port,
            InstalledBrowser {
                evergreen: false,
                grant_error: false,
                grants: Vec::new(),
                folders: Vec::new(),
            },
            0,
        );
        assert_eq!(
            missing_report.result.expect_err("missing browser"),
            "bundled WebView2 is missing"
        );
        assert!(!missing
            .app_data()
            .join("runtime")
            .join("webview2")
            .join(".complete")
            .exists());
        assert_eq!(
            std::fs::read_to_string(missing.app_data().join("boot.log")).unwrap(),
            "bundled WebView2 is missing"
        );
    }

    #[test]
    fn a_legacy_sqlite_file_beside_the_executable_is_handed_to_the_server() {
        let fixture = Fixture::new();
        write_portable(&fixture.exe(), &standard_payload());
        let sqlite = fixture
            .exe()
            .parent()
            .unwrap()
            .join("desktop-data")
            .join("resumes.sqlite");
        std::fs::create_dir_all(sqlite.parent().unwrap()).unwrap();
        std::fs::write(&sqlite, b"legacy").unwrap();
        let seen = Arc::new(Mutex::new(None));
        let seen_spawn = Arc::clone(&seen);
        struct RememberSqlite {
            seen: Arc<Mutex<Option<PathBuf>>>,
            port: u16,
        }
        impl ProcessHost for RememberSqlite {
            fn spawn_server(&mut self, launch: &ServerLaunch) -> Result<u32, String> {
                *self.seen.lock().unwrap() = launch.legacy_sqlite.clone();
                let server = Server::http(format!("127.0.0.1:{}", self.port)).unwrap();
                std::thread::spawn(move || {
                    for mut request in server.incoming_requests() {
                        let _ = request.as_reader().read_to_end(&mut Vec::new());
                        let _ = request.respond(Response::empty(StatusCode(200)));
                    }
                });
                Ok(9)
            }
            fn stop(&mut self, _pid: u32) {}
        }
        let events = Arc::new(Mutex::new(Vec::new()));
        let mut clock = FakeClock { sleeps: Vec::new() };
        let mut surface = RecordingSurface {
            events,
            node_exe: fixture.node_exe(),
        };
        let mut browser = InstalledBrowser::system();
        let mut processes = RememberSqlite {
            seen: seen_spawn,
            port: fixture.port,
        };
        let exe = fixture.exe();
        let app_data = fixture.app_data();
        let mut boot = PortableBoot {
            executable: &exe,
            app_data: &app_data,
            port: fixture.port,
            clock: &mut clock,
            surface: &mut surface,
            browser: &mut browser,
            processes: &mut processes,
        };
        boot_portable(&mut boot).unwrap();
        assert_eq!(seen.lock().unwrap().clone().unwrap(), sqlite);
    }
}
