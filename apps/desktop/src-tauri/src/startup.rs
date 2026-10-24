use std::path::{Path, PathBuf};
use std::time::Duration;

pub(crate) trait Clock {
    fn sleep(&mut self, duration: Duration);
}

pub(crate) trait StartupSurface {
    fn show_local(&mut self, status: &str) -> bool;
    fn present_failure(&mut self, reason: &str) -> BootOutcome;
    fn report_without_window(&mut self, reason: &str);
    fn navigate(&mut self, url: &str) -> Result<(), String>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BootOutcome {
    Running,
    FailedInWindow,
    FailedWithoutWindow,
}

impl BootOutcome {
    pub(crate) fn exit_required(self) -> bool {
        self == Self::FailedWithoutWindow
    }
}

pub(crate) trait BrowserHost {
    fn evergreen_installed(&mut self) -> bool;
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

pub(crate) struct DesktopBoot<'a> {
    pub executable: &'a Path,
    pub runtime_override: Option<&'a Path>,
    pub app_data: &'a Path,
    pub instance_lock: &'a Path,
    pub port: u16,
    pub clock: &'a mut dyn Clock,
    pub surface: &'a mut dyn StartupSurface,
    pub browser: &'a mut dyn BrowserHost,
    pub processes: &'a mut dyn ProcessHost,
}

const POLL_INTERVAL: Duration = Duration::from_millis(100);
const HEALTH_DEADLINE: Duration = Duration::from_secs(180);
const WEBVIEW_MISSING: &str = "Microsoft Edge WebView2 runtime is not installed; install the Microsoft Edge WebView2 Runtime to run Fulei Resume";
const WINDOW_UNAVAILABLE: &str = "the startup window could not be created";

pub(crate) fn start(boot: &mut DesktopBoot<'_>) -> BootOutcome {
    match run(boot) {
        Ok(()) => BootOutcome::Running,
        Err(reason) => fail(boot.surface, Some(boot.app_data), &reason),
    }
}

pub(crate) fn fail(
    surface: &mut dyn StartupSurface,
    app_data: Option<&Path>,
    reason: &str,
) -> BootOutcome {
    if let Some(app_data) = app_data {
        append_boot_reason(app_data, reason);
    }
    surface.present_failure(reason)
}

fn append_boot_reason(app_data: &Path, reason: &str) {
    let _ = std::fs::create_dir_all(app_data);
    let log = app_data.join("boot.log");
    let already_recorded = std::fs::read_to_string(&log)
        .map(|contents| contents.lines().last() == Some(reason))
        .unwrap_or(false);
    if already_recorded {
        return;
    }
    let mut line = reason.to_string();
    line.push('\n');
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log)
        .and_then(|mut file| std::io::Write::write_all(&mut file, line.as_bytes()));
}

fn run(boot: &mut DesktopBoot<'_>) -> Result<(), String> {
    let _instance = match SingleInstance::acquire(boot.instance_lock) {
        Ok(guard) => guard,
        Err(reason) => return Err(reason),
    };
    if port_is_busy(boot.port) {
        return Err(format!("port {} is already in use", boot.port));
    }
    let windowed = boot.surface.show_local("preparing");
    let evergreen = boot.browser.evergreen_installed();
    if !evergreen {
        boot.surface.report_without_window(WEBVIEW_MISSING);
        return Err(WEBVIEW_MISSING.to_string());
    }
    if !windowed {
        boot.surface.report_without_window(WINDOW_UNAVAILABLE);
        return Err(WINDOW_UNAVAILABLE.to_string());
    }
    let runtime = runtime_root(boot.executable, boot.runtime_override);
    let node = runtime.join("node").join("node.exe");
    let script = runtime.join("server").join("desktop-host.mjs");
    let web_dist = runtime.join("web").join("dist");
    require_file(
        &node,
        &format!("Node runtime is missing: {}", node.display()),
    )?;
    require_file(
        &script,
        &format!("desktop server entry is missing: {}", script.display()),
    )?;
    let index = web_dist.join("index.html");
    require_file(
        &index,
        &format!("web build is missing: {}", index.display()),
    )?;
    boot.surface.show_local("launching");
    let data_dir = boot.app_data.join("data");
    std::fs::create_dir_all(&data_dir).map_err(|error| error.to_string())?;
    let pid = boot.processes.spawn_server(&ServerLaunch {
        node,
        script: script.clone(),
        current_dir: script.parent().map(Path::to_path_buf).unwrap_or_default(),
        data_dir,
        web_dist,
        port: boot.port,
        legacy_sqlite: legacy_sqlite(boot.executable),
    })?;
    if let Err(error) = wait_until_healthy(boot.port, boot.clock) {
        boot.processes.stop(pid);
        return Err(error);
    }
    if let Err(reason) = boot
        .surface
        .navigate(&format!("http://127.0.0.1:{}/desktop/enter", boot.port))
    {
        boot.processes.stop(pid);
        return Err(reason);
    }
    reclaim_legacy_runtime(boot.app_data);
    Ok(())
}

fn reclaim_legacy_runtime(app_data: &Path) {
    let legacy = app_data.join("runtime");
    let Ok(metadata) = std::fs::symlink_metadata(&legacy) else {
        return;
    };
    if !metadata.is_dir() {
        return;
    }
    let _ = std::fs::remove_dir_all(&legacy);
}

fn runtime_root(executable: &Path, override_dir: Option<&Path>) -> PathBuf {
    #[cfg(debug_assertions)]
    if let Some(directory) = override_dir {
        return directory.to_path_buf();
    }
    #[cfg(not(debug_assertions))]
    let _ = override_dir;
    executable
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default()
}

fn require_file(path: &Path, message: &str) -> Result<(), String> {
    if path.is_file() {
        Ok(())
    } else {
        Err(message.to_string())
    }
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

struct SingleInstance {
    _file: std::fs::File,
}

impl SingleInstance {
    fn acquire(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(false);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(0);
        }
        match options.open(path) {
            Ok(file) => Ok(Self { _file: file }),
            Err(error) if is_already_running(&error) => {
                Err("Fulei Resume is already running; close the other window first".to_string())
            }
            Err(error) => Err(format!("could not lock the desktop instance: {error}")),
        }
    }
}

fn is_already_running(error: &std::io::Error) -> bool {
    #[cfg(windows)]
    {
        const SHARING_VIOLATION: i32 = 32;
        const LOCK_VIOLATION: i32 = 33;
        if matches!(
            error.raw_os_error(),
            Some(SHARING_VIOLATION | LOCK_VIOLATION)
        ) {
            return true;
        }
    }
    error.kind() == std::io::ErrorKind::PermissionDenied
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

#[cfg(debug_assertions)]
pub(crate) fn runtime_override() -> Option<PathBuf> {
    let value = std::env::var("REACTIVE_RESUME_RUNTIME_DIR").ok()?;
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| PathBuf::from(trimmed))
}

#[cfg(not(debug_assertions))]
pub(crate) fn runtime_override() -> Option<PathBuf> {
    None
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    use std::os::windows::fs::OpenOptionsExt;
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
        window_available: bool,
        navigation: Result<(), String>,
    }

    impl StartupSurface for RecordingSurface {
        fn show_local(&mut self, status: &str) -> bool {
            self.events
                .lock()
                .expect("events")
                .push(format!("show:{status}"));
            self.window_available
        }

        fn present_failure(&mut self, reason: &str) -> BootOutcome {
            self.events
                .lock()
                .expect("events")
                .push(format!("failure:{reason}"));
            if self.window_available {
                BootOutcome::FailedInWindow
            } else {
                BootOutcome::FailedWithoutWindow
            }
        }

        fn report_without_window(&mut self, reason: &str) {
            self.events
                .lock()
                .expect("events")
                .push(format!("native:{reason}"));
        }

        fn navigate(&mut self, url: &str) -> Result<(), String> {
            self.events
                .lock()
                .expect("events")
                .push(format!("navigate:{url}"));
            self.navigation.clone()
        }
    }

    struct TestBrowser {
        evergreen: bool,
    }

    impl BrowserHost for TestBrowser {
        fn evergreen_installed(&mut self) -> bool {
            self.evergreen
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
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let port = free_port();
            let root = std::env::temp_dir().join(format!(
                "rr-startup-{}-{}-{}",
                std::process::id(),
                port,
                NEXT.fetch_add(1, Ordering::SeqCst)
            ));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(root.join("app")).expect("app data");
            std::fs::create_dir_all(root.join("install")).expect("install dir");
            Self { root, port }
        }

        fn install(&self) -> PathBuf {
            self.root.join("install")
        }

        fn exe(&self) -> PathBuf {
            self.install().join("Fulei Resume.exe")
        }

        fn app_data(&self) -> PathBuf {
            self.root.join("app")
        }

        fn instance_lock(&self) -> PathBuf {
            self.app_data().join("instance.lock")
        }

        fn node_exe(&self) -> PathBuf {
            self.install().join("node").join("node.exe")
        }

        fn server_entry(&self) -> PathBuf {
            self.install().join("server").join("desktop-host.mjs")
        }

        fn web_index(&self) -> PathBuf {
            self.install().join("web").join("dist").join("index.html")
        }

        fn write_runtime(&self) {
            write_file(&self.exe(), b"MZ-sibling-runtime");
            write_file(&self.node_exe(), b"node-bytes");
            write_file(&self.server_entry(), b"server-bytes");
            write_file(&self.web_index(), b"web-bytes");
        }

        fn boot_log(&self) -> String {
            std::fs::read_to_string(self.app_data().join("boot.log"))
                .expect("boot log")
                .trim_end()
                .to_string()
        }

        fn legacy_runtime(&self) -> PathBuf {
            self.app_data().join("runtime")
        }

        fn write_legacy_runtime(&self) {
            write_file(
                &self.legacy_runtime().join("node").join("node.exe"),
                b"legacy-node-bytes",
            );
            write_file(
                &self
                    .legacy_runtime()
                    .join("server")
                    .join("desktop-host.mjs"),
                b"legacy-server-bytes",
            );
            write_file(
                &self
                    .legacy_runtime()
                    .join("web")
                    .join("dist")
                    .join("index.html"),
                b"legacy-web-bytes",
            );
        }

        fn write_user_state(&self) {
            write_file(&self.resume(), b"{\"id\":\"one\",\"name\":\"Mine\"}");
            write_file(&self.app_data().join("server.log"), b"server log line\n");
            write_file(&self.boot_log_path(), b"previous boot log\n");
            write_file(
                &self.app_data().join("provider.json"),
                b"{\"baseUrl\":\"\",\"model\":\"\"}",
            );
        }

        fn resume(&self) -> PathBuf {
            self.app_data()
                .join("data")
                .join("resumes")
                .join("one.json")
        }

        fn boot_log_path(&self) -> PathBuf {
            self.app_data().join("boot.log")
        }

        fn assert_user_state_intact(&self) {
            assert_eq!(
                std::fs::read(self.resume()).expect("resume"),
                b"{\"id\":\"one\",\"name\":\"Mine\"}"
            );
            assert_eq!(
                std::fs::read(self.app_data().join("server.log")).expect("server log"),
                b"server log line\n"
            );
            assert_eq!(
                std::fs::read(self.boot_log_path()).expect("boot log"),
                b"previous boot log\n"
            );
            assert_eq!(
                std::fs::read(self.app_data().join("provider.json")).expect("provider"),
                b"{\"baseUrl\":\"\",\"model\":\"\"}"
            );
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn free_port() -> u16 {
        std::net::TcpListener::bind("127.0.0.1:0")
            .expect("port")
            .local_addr()
            .expect("addr")
            .port()
    }

    fn write_file(path: &Path, bytes: &[u8]) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("parent");
        }
        std::fs::write(path, bytes).expect("write");
    }

    struct BootReport {
        outcome: BootOutcome,
        events: Vec<String>,
        sleeps: Vec<Duration>,
        stopped: Vec<u32>,
    }

    struct BootOptions {
        port: u16,
        evergreen: bool,
        unhealthy_before_ok: usize,
        runtime_override: Option<PathBuf>,
        window_available: bool,
        navigation: Result<(), String>,
    }

    fn boot(
        fixture: &Fixture,
        port: u16,
        evergreen: bool,
        unhealthy_before_ok: usize,
    ) -> BootReport {
        boot_with(
            fixture,
            BootOptions {
                port,
                evergreen,
                unhealthy_before_ok,
                runtime_override: None,
                window_available: true,
                navigation: Ok(()),
            },
        )
    }

    fn boot_with(fixture: &Fixture, options: BootOptions) -> BootReport {
        let events = Arc::new(Mutex::new(Vec::new()));
        let stopped = Arc::new(Mutex::new(Vec::new()));
        let mut clock = FakeClock { sleeps: Vec::new() };
        let mut surface = RecordingSurface {
            events: Arc::clone(&events),
            window_available: options.window_available,
            navigation: options.navigation.clone(),
        };
        let mut browser = TestBrowser {
            evergreen: options.evergreen,
        };
        let mut processes = HealthServer {
            events: Arc::clone(&events),
            port: options.port,
            unhealthy_before_ok: options.unhealthy_before_ok,
            polls: Arc::new(AtomicUsize::new(0)),
            stopped: Arc::clone(&stopped),
        };
        let exe = fixture.exe();
        let app_data = fixture.app_data();
        let mut boot = DesktopBoot {
            executable: &exe,
            runtime_override: options.runtime_override.as_deref(),
            app_data: &app_data,
            instance_lock: &fixture.instance_lock(),
            port: options.port,
            clock: &mut clock,
            surface: &mut surface,
            browser: &mut browser,
            processes: &mut processes,
        };
        let outcome = start(&mut boot);
        let seen_events = events.lock().expect("events").clone();
        let seen_stopped = stopped.lock().expect("stopped").clone();
        BootReport {
            outcome,
            events: seen_events,
            sleeps: clock.sleeps,
            stopped: seen_stopped,
        }
    }

    struct NeverSpawned;

    impl ProcessHost for NeverSpawned {
        fn spawn_server(&mut self, _launch: &ServerLaunch) -> Result<u32, String> {
            panic!("the server was spawned for an incomplete runtime");
        }

        fn stop(&mut self, _pid: u32) {
            panic!("the server was stopped for an incomplete runtime");
        }
    }

    fn boot_without_spawn(fixture: &Fixture) -> BootReport {
        boot_without_spawn_in(fixture, true)
    }

    fn boot_without_spawn_in(fixture: &Fixture, window_available: bool) -> BootReport {
        boot_without_spawn_and_browser(fixture, window_available, true)
    }

    fn boot_without_spawn_and_browser(
        fixture: &Fixture,
        window_available: bool,
        evergreen: bool,
    ) -> BootReport {
        let events = Arc::new(Mutex::new(Vec::new()));
        let mut clock = FakeClock { sleeps: Vec::new() };
        let mut surface = RecordingSurface {
            events: Arc::clone(&events),
            window_available,
            navigation: Ok(()),
        };
        let mut browser = TestBrowser { evergreen };
        let mut processes = NeverSpawned;
        let exe = fixture.exe();
        let app_data = fixture.app_data();
        let mut boot = DesktopBoot {
            executable: &exe,
            runtime_override: None,
            app_data: &app_data,
            instance_lock: &fixture.instance_lock(),
            port: fixture.port,
            clock: &mut clock,
            surface: &mut surface,
            browser: &mut browser,
            processes: &mut processes,
        };
        let outcome = start(&mut boot);
        let seen_events = events.lock().expect("events").clone();
        BootReport {
            outcome,
            events: seen_events,
            sleeps: clock.sleeps,
            stopped: Vec::new(),
        }
    }

    fn assert_presented_in_the_window(report: &BootReport, fixture: &Fixture, reason: &str) {
        assert_eq!(report.outcome, BootOutcome::FailedInWindow);
        assert!(!report.outcome.exit_required());
        assert_presented(report, fixture, reason);
    }

    fn assert_presented_without_a_window(report: &BootReport, fixture: &Fixture, reason: &str) {
        assert_eq!(report.outcome, BootOutcome::FailedWithoutWindow);
        assert!(report.outcome.exit_required());
        assert!(
            report.events.contains(&format!("native:{reason}")),
            "the user was never told {reason:?}; saw {:?}",
            report.events
        );
        assert_presented(report, fixture, reason);
    }

    fn assert_presented(report: &BootReport, fixture: &Fixture, reason: &str) {
        assert!(
            report.events.contains(&format!("failure:{reason}")),
            "the surface never presented {reason:?}; saw {:?}",
            report.events
        );
        assert!(
            !report
                .events
                .iter()
                .any(|event| event.starts_with("navigate:")),
            "a failed startup navigated; saw {:?}",
            report.events
        );
        assert_eq!(fixture.boot_log(), reason);
    }

    #[test]
    fn startup_shows_progress_spawns_the_server_and_opens_desktop_enter() {
        let fixture = Fixture::new();
        fixture.write_runtime();

        let report = boot(&fixture, fixture.port, true, 1);

        assert_eq!(report.outcome, BootOutcome::Running);
        assert_eq!(
            report.events,
            vec![
                "show:preparing".to_string(),
                "show:launching".to_string(),
                "spawn".to_string(),
                format!("navigate:http://127.0.0.1:{}/desktop/enter", fixture.port),
            ]
        );
        assert_eq!(report.sleeps, vec![Duration::from_millis(100)]);
        assert!(fixture.app_data().join("data").is_dir());
        assert!(!fixture.app_data().join("boot.log").exists());
    }

    #[test]
    fn stale_trailer_bytes_at_the_executable_tail_are_ignored() {
        let fixture = Fixture::new();
        fixture.write_runtime();
        let mut exe_bytes = std::fs::read(fixture.exe()).expect("exe");
        exe_bytes.extend_from_slice(b"RRPORTABLE!!!!!\n");
        exe_bytes.extend_from_slice(&64_u64.to_le_bytes());
        exe_bytes.extend_from_slice(&[0_u8; 56]);
        std::fs::write(fixture.exe(), &exe_bytes).expect("stale tail");

        let report = boot(&fixture, fixture.port, true, 0);

        assert_eq!(report.outcome, BootOutcome::Running);
        let expected = format!("navigate:http://127.0.0.1:{}/desktop/enter", fixture.port);
        assert_eq!(report.events.last(), Some(&expected));
    }

    #[test]
    fn a_missing_node_is_presented_in_the_window_and_never_spawns_the_server() {
        let fixture = Fixture::new();
        fixture.write_runtime();
        std::fs::remove_file(fixture.node_exe()).expect("remove node");

        let report = boot_without_spawn(&fixture);

        let reason = format!("Node runtime is missing: {}", fixture.node_exe().display());
        assert_presented_in_the_window(&report, &fixture, &reason);
        assert!(!report.events.iter().any(|event| event == "spawn"));
        assert!(report.sleeps.is_empty());
    }

    #[test]
    fn a_missing_server_entry_is_presented_in_the_window_and_never_spawns_the_server() {
        let fixture = Fixture::new();
        fixture.write_runtime();
        std::fs::remove_file(fixture.server_entry()).expect("remove server entry");

        let report = boot_without_spawn(&fixture);

        let reason = format!(
            "desktop server entry is missing: {}",
            fixture.server_entry().display()
        );
        assert_presented_in_the_window(&report, &fixture, &reason);
        assert!(!report.events.iter().any(|event| event == "spawn"));
        assert!(report.sleeps.is_empty());
    }

    #[test]
    fn a_missing_web_index_is_presented_in_the_window_and_never_spawns_the_server() {
        let fixture = Fixture::new();
        fixture.write_runtime();
        std::fs::remove_file(fixture.web_index()).expect("remove web index");

        let report = boot_without_spawn(&fixture);

        let reason = format!("web build is missing: {}", fixture.web_index().display());
        assert_presented_in_the_window(&report, &fixture, &reason);
        assert!(!report.events.iter().any(|event| event == "spawn"));
        assert!(report.sleeps.is_empty());
    }

    #[test]
    fn a_busy_port_is_presented_in_the_window_before_runtime_validation_or_the_health_wait() {
        let fixture = Fixture::new();
        let _listener = std::net::TcpListener::bind(("127.0.0.1", fixture.port)).expect("listener");

        let report = boot_without_spawn(&fixture);

        let reason = format!("port {} is already in use", fixture.port);
        assert_presented_in_the_window(&report, &fixture, &reason);
        assert_eq!(report.events, vec![format!("failure:{reason}")]);
        assert!(!report.events.iter().any(|event| event == "spawn"));
        assert!(report.sleeps.is_empty());
    }

    #[test]
    fn the_health_deadline_is_presented_in_the_window_after_the_spawned_server_stops() {
        let fixture = Fixture::new();
        fixture.write_runtime();

        let report = boot(&fixture, fixture.port, true, usize::MAX);

        assert_eq!(report.stopped, vec![77]);
        assert_eq!(report.sleeps.len(), 1800);
        assert!(report
            .sleeps
            .iter()
            .all(|sleep| *sleep == Duration::from_millis(100)));
        assert_presented_in_the_window(&report, &fixture, "desktop server did not become healthy");
    }

    #[test]
    fn a_missing_evergreen_webview_is_presented_to_the_user_and_leaves_no_side_effects() {
        let fixture = Fixture::new();
        fixture.write_runtime();
        let before = install_tree(&fixture.install());

        let report = boot_without_spawn_and_browser(&fixture, false, false);

        assert_presented_without_a_window(&report, &fixture, WEBVIEW_MISSING);
        assert_eq!(
            report.events,
            vec![
                "show:preparing".to_string(),
                format!("native:{WEBVIEW_MISSING}"),
                format!("failure:{WEBVIEW_MISSING}"),
            ]
        );
        assert_eq!(report.outcome, BootOutcome::FailedWithoutWindow);
        assert!(report.sleeps.is_empty());
        assert!(report.stopped.is_empty());
        assert_eq!(install_tree(&fixture.install()), before);
    }

    #[test]
    fn a_second_instance_fails_before_touching_the_server_even_before_the_port_is_taken() {
        let fixture = Fixture::new();
        fixture.write_runtime();
        let held = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .share_mode(0)
            .open(fixture.instance_lock())
            .expect("hold the instance lock");

        let report = boot_without_spawn(&fixture);
        let reason = "Fulei Resume is already running; close the other window first";
        assert_presented_in_the_window(&report, &fixture, reason);
        assert!(report.stopped.is_empty());
        drop(held);
        assert_eq!(
            boot(&fixture, fixture.port, true, 0).outcome,
            BootOutcome::Running
        );
    }

    #[test]
    fn the_startup_page_is_created_before_the_evergreen_check_runs() {
        let fixture = Fixture::new();
        fixture.write_runtime();

        let report = boot(&fixture, fixture.port, false, 0);

        let shown = report
            .events
            .iter()
            .position(|event| event == "show:preparing")
            .expect("the startup page was created");
        let failed = report
            .events
            .iter()
            .position(|event| event.starts_with("failure:"))
            .expect("the failure was presented");
        assert!(shown < failed);
    }

    #[test]
    fn a_failure_without_a_window_still_writes_the_log_and_demands_a_non_zero_exit() {
        let fixture = Fixture::new();
        fixture.write_runtime();
        std::fs::remove_file(fixture.node_exe()).expect("remove node");

        let report = boot_without_spawn_in(&fixture, false);

        assert_eq!(report.outcome, BootOutcome::FailedWithoutWindow);
        assert!(report.outcome.exit_required());
        assert_eq!(fixture.boot_log(), WINDOW_UNAVAILABLE);
    }

    #[test]
    fn a_missing_webview_without_a_window_still_writes_the_log_and_demands_a_non_zero_exit() {
        let fixture = Fixture::new();
        fixture.write_runtime();

        let report = boot_without_spawn_and_browser(&fixture, false, false);

        assert_eq!(report.outcome, BootOutcome::FailedWithoutWindow);
        assert!(report.outcome.exit_required());
        assert_eq!(fixture.boot_log(), WEBVIEW_MISSING);
    }

    #[test]
    fn every_startup_failure_reason_reaches_the_window_and_the_log() {
        let busy = Fixture::new();
        let listener = std::net::TcpListener::bind(("127.0.0.1", busy.port)).expect("listener");
        let report = boot_without_spawn(&busy);
        let port_reason = format!("port {} is already in use", busy.port);
        assert_presented_in_the_window(&report, &busy, &port_reason);
        drop(listener);

        let node = Fixture::new();
        node.write_runtime();
        std::fs::remove_file(node.node_exe()).expect("remove node");
        let report = boot_without_spawn(&node);
        let node_reason = format!("Node runtime is missing: {}", node.node_exe().display());
        assert_presented_in_the_window(&report, &node, &node_reason);

        let server = Fixture::new();
        server.write_runtime();
        std::fs::remove_file(server.server_entry()).expect("remove server entry");
        let report = boot_without_spawn(&server);
        let server_reason = format!(
            "desktop server entry is missing: {}",
            server.server_entry().display()
        );
        assert_presented_in_the_window(&report, &server, &server_reason);

        let web = Fixture::new();
        web.write_runtime();
        std::fs::remove_file(web.web_index()).expect("remove web index");
        let report = boot_without_spawn(&web);
        let web_reason = format!("web build is missing: {}", web.web_index().display());
        assert_presented_in_the_window(&report, &web, &web_reason);

        let evergreen = Fixture::new();
        evergreen.write_runtime();
        let report = boot(&evergreen, evergreen.port, false, 0);
        assert_presented_in_the_window(&report, &evergreen, WEBVIEW_MISSING);

        let timeout = Fixture::new();
        timeout.write_runtime();
        let report = boot(&timeout, timeout.port, true, usize::MAX);
        assert_presented_in_the_window(&report, &timeout, "desktop server did not become healthy");
    }

    fn install_tree(root: &Path) -> Vec<String> {
        fn walk(directory: &Path, prefix: &str, found: &mut Vec<String>) {
            let Ok(entries) = std::fs::read_dir(directory) else {
                return;
            };
            let mut names: Vec<String> = entries
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect();
            names.sort();
            for name in names {
                let path = directory.join(&name);
                let relative = format!("{prefix}{name}");
                if path.is_dir() {
                    found.push(format!("{relative}/"));
                    walk(&path, &format!("{relative}/"), found);
                } else {
                    found.push(relative);
                }
            }
        }
        let mut found = Vec::new();
        walk(root, "", &mut found);
        found
    }

    #[test]
    fn startup_writes_nothing_into_the_install_directory() {
        let fixture = Fixture::new();
        fixture.write_runtime();
        let before = install_tree(&fixture.install());

        assert_eq!(
            boot(&fixture, fixture.port, true, 0).outcome,
            BootOutcome::Running
        );

        assert_eq!(install_tree(&fixture.install()), before);
        assert!(!fixture.install().join("runtime").exists());
        assert!(!fixture.install().join("boot.log").exists());
    }

    #[test]
    fn resumes_in_the_data_directory_survive_repeated_startups() {
        let fixture = Fixture::new();
        fixture.write_runtime();
        let resume = fixture
            .app_data()
            .join("data")
            .join("resumes")
            .join("one.json");
        write_file(&resume, b"{\"id\":\"one\"}");

        assert_eq!(
            boot(&fixture, fixture.port, true, 0).outcome,
            BootOutcome::Running
        );
        assert_eq!(
            boot(&fixture, free_port(), true, 0).outcome,
            BootOutcome::Running
        );

        assert_eq!(std::fs::read(&resume).expect("resume"), b"{\"id\":\"one\"}");
    }

    #[test]
    fn a_successful_start_reclaims_the_legacy_portable_runtime_and_keeps_user_state() {
        let fixture = Fixture::new();
        fixture.write_runtime();
        fixture.write_legacy_runtime();
        fixture.write_user_state();

        let report = boot(&fixture, fixture.port, true, 0);

        assert_eq!(report.outcome, BootOutcome::Running);
        assert!(
            !fixture.legacy_runtime().exists(),
            "the legacy runtime survived a successful start at {}",
            fixture.legacy_runtime().display()
        );
        fixture.assert_user_state_intact();
        assert!(fixture.app_data().join("data").is_dir());
    }

    #[test]
    fn a_failed_start_leaves_the_legacy_portable_runtime_untouched() {
        let fixture = Fixture::new();
        fixture.write_runtime();
        fixture.write_legacy_runtime();
        std::fs::remove_file(fixture.node_exe()).expect("remove node");

        let report = boot_without_spawn(&fixture);

        let reason = format!("Node runtime is missing: {}", fixture.node_exe().display());
        assert_presented_in_the_window(&report, &fixture, &reason);
        assert!(fixture
            .legacy_runtime()
            .join("node")
            .join("node.exe")
            .is_file());
        assert!(fixture
            .legacy_runtime()
            .join("web")
            .join("dist")
            .join("index.html")
            .is_file());
    }

    #[test]
    fn a_legacy_runtime_that_is_not_a_directory_is_left_alone() {
        let fixture = Fixture::new();
        fixture.write_runtime();
        fixture.write_user_state();
        write_file(&fixture.legacy_runtime(), b"not-a-directory");

        let report = boot(&fixture, fixture.port, true, 0);

        assert_eq!(report.outcome, BootOutcome::Running);
        assert_eq!(
            std::fs::read(fixture.legacy_runtime()).expect("runtime file"),
            b"not-a-directory"
        );
        fixture.assert_user_state_intact();
    }

    #[test]
    fn a_health_failure_after_the_spawn_leaves_the_legacy_portable_runtime_untouched() {
        let fixture = Fixture::new();
        fixture.write_runtime();
        fixture.write_legacy_runtime();

        let report = boot(&fixture, fixture.port, true, usize::MAX);

        assert_eq!(report.stopped, vec![77]);
        assert_presented_in_the_window(&report, &fixture, "desktop server did not become healthy");
        assert!(fixture.legacy_runtime().is_dir());
    }

    #[test]
    fn a_missing_legacy_portable_runtime_is_a_no_op_and_the_start_still_succeeds() {
        let fixture = Fixture::new();
        fixture.write_runtime();
        fixture.write_user_state();
        assert!(!fixture.legacy_runtime().exists());

        let report = boot(&fixture, fixture.port, true, 0);

        assert_eq!(report.outcome, BootOutcome::Running);
        assert!(!fixture.legacy_runtime().exists());
        fixture.assert_user_state_intact();
    }

    #[cfg(windows)]
    #[test]
    fn a_failed_reclaim_does_not_fail_startup_and_a_later_start_retries() {
        let fixture = Fixture::new();
        fixture.write_runtime();
        fixture.write_legacy_runtime();
        fixture.write_user_state();
        let locked = fixture.legacy_runtime().join("node").join("node.exe");

        let first = {
            let _held = hold_against_deletion(&locked);
            boot(&fixture, fixture.port, true, 0)
        };

        assert_eq!(first.outcome, BootOutcome::Running);
        assert_eq!(
            first.events.last(),
            Some(&format!(
                "navigate:http://127.0.0.1:{}/desktop/enter",
                fixture.port
            ))
        );
        assert!(
            fixture.legacy_runtime().exists(),
            "the reclaim unexpectedly succeeded while a file was held open"
        );
        fixture.assert_user_state_intact();

        let second = boot(&fixture, free_port(), true, 0);

        assert_eq!(second.outcome, BootOutcome::Running);
        assert!(!fixture.legacy_runtime().exists());
        fixture.assert_user_state_intact();
    }

    #[cfg(windows)]
    fn hold_against_deletion(path: &Path) -> std::fs::File {
        use std::os::windows::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(path)
            .expect("hold")
    }

    #[test]
    fn a_navigation_failure_is_recorded_and_never_leaves_the_splash_spinning() {
        let fixture = Fixture::new();
        fixture.write_runtime();

        let reason = "the startup window could not navigate";
        let report = boot_with(
            &fixture,
            BootOptions {
                port: fixture.port,
                evergreen: true,
                unhealthy_before_ok: 0,
                runtime_override: None,
                window_available: true,
                navigation: Err(reason.to_string()),
            },
        );

        assert_eq!(report.outcome, BootOutcome::FailedInWindow);
        assert_eq!(report.stopped, vec![77]);
        assert!(
            report.events.contains(&format!("failure:{reason}")),
            "the failure never reached the window; saw {:?}",
            report.events
        );
        assert_eq!(fixture.boot_log(), reason);
    }

    #[test]
    fn the_legacy_sqlite_beside_the_executable_is_handed_to_the_server() {
        let fixture = Fixture::new();
        fixture.write_runtime();
        let sqlite = fixture
            .install()
            .join("desktop-data")
            .join("resumes.sqlite");
        write_file(&sqlite, b"legacy");

        let seen = Arc::new(Mutex::new(None));
        struct RememberSqlite {
            seen: Arc<Mutex<Option<PathBuf>>>,
            port: u16,
        }
        impl ProcessHost for RememberSqlite {
            fn spawn_server(&mut self, launch: &ServerLaunch) -> Result<u32, String> {
                *self.seen.lock().expect("seen") = launch.legacy_sqlite.clone();
                let server = Server::http(format!("127.0.0.1:{}", self.port)).expect("stub");
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

        let mut clock = FakeClock { sleeps: Vec::new() };
        let mut surface = RecordingSurface {
            events: Arc::new(Mutex::new(Vec::new())),
            window_available: true,
            navigation: Ok(()),
        };
        let mut browser = TestBrowser { evergreen: true };
        let mut processes = RememberSqlite {
            seen: Arc::clone(&seen),
            port: fixture.port,
        };
        let exe = fixture.exe();
        let app_data = fixture.app_data();
        let mut boot = DesktopBoot {
            executable: &exe,
            runtime_override: None,
            app_data: &app_data,
            instance_lock: &fixture.instance_lock(),
            port: fixture.port,
            clock: &mut clock,
            surface: &mut surface,
            browser: &mut browser,
            processes: &mut processes,
        };

        assert_eq!(start(&mut boot), BootOutcome::Running);

        assert_eq!(seen.lock().expect("seen").clone().expect("sqlite"), sqlite);
    }

    #[cfg(debug_assertions)]
    #[test]
    fn a_debug_build_reads_the_runtime_override_from_the_environment() {
        let fixture = Fixture::new();
        fixture.write_runtime();
        let elsewhere = fixture.root.join("prepared-runtime");
        write_file(&elsewhere.join("node").join("node.exe"), b"node-bytes");
        write_file(
            &elsewhere.join("server").join("desktop-host.mjs"),
            b"server",
        );
        write_file(
            &elsewhere.join("web").join("dist").join("index.html"),
            b"web",
        );

        std::env::set_var("REACTIVE_RESUME_RUNTIME_DIR", &elsewhere);
        let resolved = runtime_override();
        std::env::remove_var("REACTIVE_RESUME_RUNTIME_DIR");

        assert_eq!(resolved, Some(elsewhere));
        assert_eq!(runtime_override(), None);
    }

    #[cfg(debug_assertions)]
    #[test]
    fn the_runtime_override_replaces_the_directory_beside_the_executable() {
        let fixture = Fixture::new();
        write_file(&fixture.exe(), b"exe");
        let elsewhere = fixture.root.join("prepared-runtime");
        write_file(&elsewhere.join("node").join("node.exe"), b"node-bytes");
        write_file(
            &elsewhere.join("server").join("desktop-host.mjs"),
            b"server",
        );
        write_file(
            &elsewhere.join("web").join("dist").join("index.html"),
            b"web",
        );

        let report = boot_with(
            &fixture,
            BootOptions {
                port: fixture.port,
                evergreen: true,
                unhealthy_before_ok: 0,
                runtime_override: Some(elsewhere),
                window_available: true,
                navigation: Ok(()),
            },
        );

        assert_eq!(report.outcome, BootOutcome::Running);
        assert!(report.events.iter().any(|event| event == "spawn"));
    }

    #[cfg(not(debug_assertions))]
    #[test]
    fn a_release_build_ignores_the_runtime_override() {
        let fixture = Fixture::new();
        let exe = fixture.exe();
        let elsewhere = fixture.root.join("prepared-runtime");

        assert_eq!(runtime_override(), None);
        assert_eq!(runtime_root(&exe, Some(&elsewhere)), fixture.install());
    }
}
