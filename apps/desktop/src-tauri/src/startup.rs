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
    pub port: u16,
    pub clock: &'a mut dyn Clock,
    pub surface: &'a mut dyn StartupSurface,
    pub browser: &'a mut dyn BrowserHost,
    pub processes: &'a mut dyn ProcessHost,
}

const POLL_INTERVAL: Duration = Duration::from_millis(100);
const HEALTH_DEADLINE: Duration = Duration::from_secs(180);

pub(crate) fn start(boot: &mut DesktopBoot<'_>) -> Result<(), String> {
    match run(boot) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = std::fs::create_dir_all(boot.app_data);
            let _ = std::fs::write(boot.app_data.join("boot.log"), &error);
            Err(error)
        }
    }
}

fn run(boot: &mut DesktopBoot<'_>) -> Result<(), String> {
    if port_is_busy(boot.port) {
        return Err(format!("port {} is already in use", boot.port));
    }
    if !boot.browser.evergreen_installed() {
        return Err(
            "Microsoft Edge WebView2 runtime is not installed; install the Microsoft Edge WebView2 Runtime to run Reactive Resume"
                .to_string(),
        );
    }
    boot.surface.show_local("Preparing the runtime");
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
    boot.surface.show_local("Starting the app");
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
    boot.surface
        .navigate(&format!("http://127.0.0.1:{}/desktop/enter", boot.port));
    Ok(())
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
    }

    impl StartupSurface for RecordingSurface {
        fn show_local(&mut self, status: &str) {
            self.events
                .lock()
                .expect("events")
                .push(format!("show:{status}"));
        }

        fn navigate(&mut self, url: &str) {
            self.events
                .lock()
                .expect("events")
                .push(format!("navigate:{url}"));
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
            self.install().join("Reactive Resume.exe")
        }

        fn app_data(&self) -> PathBuf {
            self.root.join("app")
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
        result: Result<(), String>,
        events: Vec<String>,
        sleeps: Vec<Duration>,
        stopped: Vec<u32>,
    }

    fn boot(
        fixture: &Fixture,
        port: u16,
        evergreen: bool,
        unhealthy_before_ok: usize,
    ) -> BootReport {
        boot_with(fixture, port, evergreen, unhealthy_before_ok, None)
    }

    fn boot_with(
        fixture: &Fixture,
        port: u16,
        evergreen: bool,
        unhealthy_before_ok: usize,
        runtime_override: Option<&Path>,
    ) -> BootReport {
        let events = Arc::new(Mutex::new(Vec::new()));
        let stopped = Arc::new(Mutex::new(Vec::new()));
        let mut clock = FakeClock { sleeps: Vec::new() };
        let mut surface = RecordingSurface {
            events: Arc::clone(&events),
        };
        let mut browser = TestBrowser { evergreen };
        let mut processes = HealthServer {
            events: Arc::clone(&events),
            port,
            unhealthy_before_ok,
            polls: Arc::new(AtomicUsize::new(0)),
            stopped: Arc::clone(&stopped),
        };
        let exe = fixture.exe();
        let app_data = fixture.app_data();
        let mut boot = DesktopBoot {
            executable: &exe,
            runtime_override,
            app_data: &app_data,
            port,
            clock: &mut clock,
            surface: &mut surface,
            browser: &mut browser,
            processes: &mut processes,
        };
        let result = start(&mut boot);
        let seen_events = events.lock().expect("events").clone();
        let seen_stopped = stopped.lock().expect("stopped").clone();
        BootReport {
            result,
            events: seen_events,
            sleeps: clock.sleeps,
            stopped: seen_stopped,
        }
    }

    #[test]
    fn startup_shows_progress_spawns_the_server_and_opens_desktop_enter() {
        let fixture = Fixture::new();
        fixture.write_runtime();

        let report = boot(&fixture, fixture.port, true, 1);

        report.result.expect("boot");
        assert_eq!(
            report.events,
            vec![
                "show:Preparing the runtime".to_string(),
                "show:Starting the app".to_string(),
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

        report.result.expect("boot");
        let expected = format!("navigate:http://127.0.0.1:{}/desktop/enter", fixture.port);
        assert_eq!(report.events.last(), Some(&expected));
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

    fn boot_without_spawn(fixture: &Fixture) -> (Result<(), String>, Vec<String>, Vec<Duration>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let mut clock = FakeClock { sleeps: Vec::new() };
        let mut surface = RecordingSurface {
            events: Arc::clone(&events),
        };
        let mut browser = TestBrowser { evergreen: true };
        let mut processes = NeverSpawned;
        let exe = fixture.exe();
        let app_data = fixture.app_data();
        let mut boot = DesktopBoot {
            executable: &exe,
            runtime_override: None,
            app_data: &app_data,
            port: fixture.port,
            clock: &mut clock,
            surface: &mut surface,
            browser: &mut browser,
            processes: &mut processes,
        };
        let result = start(&mut boot);
        let seen_events = events.lock().expect("events").clone();
        (result, seen_events, clock.sleeps)
    }

    #[test]
    fn a_missing_node_fails_with_its_full_path_and_never_spawns_the_server() {
        let fixture = Fixture::new();
        fixture.write_runtime();
        std::fs::remove_file(fixture.node_exe()).expect("remove node");

        let (result, events, sleeps) = boot_without_spawn(&fixture);

        let error = result.expect_err("missing node");
        assert_eq!(
            error,
            format!("Node runtime is missing: {}", fixture.node_exe().display())
        );
        assert!(!events.iter().any(|event| event == "spawn"));
        assert!(sleeps.is_empty());
        assert_eq!(
            std::fs::read_to_string(fixture.app_data().join("boot.log")).expect("boot log"),
            error
        );
    }

    #[test]
    fn a_missing_server_entry_fails_with_its_full_path_and_never_spawns_the_server() {
        let fixture = Fixture::new();
        fixture.write_runtime();
        std::fs::remove_file(fixture.server_entry()).expect("remove server entry");

        let (result, events, sleeps) = boot_without_spawn(&fixture);

        let error = result.expect_err("missing server entry");
        assert_eq!(
            error,
            format!(
                "desktop server entry is missing: {}",
                fixture.server_entry().display()
            )
        );
        assert!(!events.iter().any(|event| event == "spawn"));
        assert!(sleeps.is_empty());
    }

    #[test]
    fn a_missing_web_index_fails_with_its_full_path_and_never_spawns_the_server() {
        let fixture = Fixture::new();
        fixture.write_runtime();
        std::fs::remove_file(fixture.web_index()).expect("remove web index");

        let (result, events, sleeps) = boot_without_spawn(&fixture);

        let error = result.expect_err("missing web index");
        assert_eq!(
            error,
            format!("web build is missing: {}", fixture.web_index().display())
        );
        assert!(!events.iter().any(|event| event == "spawn"));
        assert!(sleeps.is_empty());
    }

    #[test]
    fn a_busy_port_fails_before_runtime_validation_or_the_health_wait() {
        let fixture = Fixture::new();
        let _listener = std::net::TcpListener::bind(("127.0.0.1", fixture.port)).expect("listener");

        let (result, events, sleeps) = boot_without_spawn(&fixture);

        let error = result.expect_err("busy port");
        assert_eq!(error, format!("port {} is already in use", fixture.port));
        assert!(events.is_empty());
        assert!(sleeps.is_empty());
        assert_eq!(
            std::fs::read_to_string(fixture.app_data().join("boot.log")).expect("boot log"),
            error
        );
    }

    #[test]
    fn the_health_deadline_stops_the_spawned_server_and_writes_boot_log() {
        let fixture = Fixture::new();
        fixture.write_runtime();

        let report = boot(&fixture, fixture.port, true, usize::MAX);

        assert_eq!(report.stopped, vec![77]);
        assert_eq!(report.sleeps.len(), 1800);
        assert!(report
            .sleeps
            .iter()
            .all(|sleep| *sleep == Duration::from_millis(100)));
        assert!(!report
            .events
            .iter()
            .any(|event| event.starts_with("navigate:")));
        let error = report.result.expect_err("timeout");
        assert_eq!(error, "desktop server did not become healthy");
        assert_eq!(
            std::fs::read_to_string(fixture.app_data().join("boot.log")).expect("boot log"),
            error
        );
    }

    #[test]
    fn a_missing_evergreen_webview_fails_with_a_clear_reason_and_leaves_no_side_effects() {
        let fixture = Fixture::new();
        fixture.write_runtime();
        let before = install_tree(&fixture.install());

        let report = boot(&fixture, fixture.port, false, 0);

        let error = report.result.expect_err("missing evergreen");
        assert_eq!(
            error,
            "Microsoft Edge WebView2 runtime is not installed; install the Microsoft Edge WebView2 Runtime to run Reactive Resume"
        );
        assert!(!report.events.iter().any(|event| event == "spawn"));
        assert!(report.sleeps.is_empty());
        assert!(report.stopped.is_empty());
        assert_eq!(install_tree(&fixture.install()), before);
        assert_eq!(
            std::fs::read_to_string(fixture.app_data().join("boot.log")).expect("boot log"),
            error
        );
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

        boot(&fixture, fixture.port, true, 0).result.expect("boot");

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

        boot(&fixture, fixture.port, true, 0)
            .result
            .expect("first boot");
        boot(&fixture, free_port(), true, 0)
            .result
            .expect("second boot");

        assert_eq!(std::fs::read(&resume).expect("resume"), b"{\"id\":\"one\"}");
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
            port: fixture.port,
            clock: &mut clock,
            surface: &mut surface,
            browser: &mut browser,
            processes: &mut processes,
        };

        start(&mut boot).expect("boot");

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

        let report = boot_with(&fixture, fixture.port, true, 0, Some(&elsewhere));

        report.result.expect("boot");
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
