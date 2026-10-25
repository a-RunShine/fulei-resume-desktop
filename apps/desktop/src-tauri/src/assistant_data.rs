use std::path::{Path, PathBuf};

pub(crate) const DATA_DIR_OVERRIDE: &str = "REACTIVE_RESUME_DATA_DIR";

pub(crate) fn data_directory(app_data: &Path, override_dir: Option<&str>) -> PathBuf {
    match override_dir {
        Some(directory) if !directory.trim().is_empty() => PathBuf::from(directory),
        _ => app_data.join("data").join("assistant"),
    }
}

pub(crate) fn legacy_data_directory() -> PathBuf {
    std::env::temp_dir().join("reactive-resume-data")
}

pub(crate) fn resolve(app_data: &Path) -> std::io::Result<PathBuf> {
    resolve_with(app_data, std::env::var(DATA_DIR_OVERRIDE).ok().as_deref())
}

pub(crate) fn resolve_with(app_data: &Path, override_dir: Option<&str>) -> std::io::Result<PathBuf> {
    let destination = data_directory(app_data, override_dir);
    let isolated = override_dir.is_some_and(|value| !value.trim().is_empty());

    if !isolated {
        adopt(&legacy_data_directory(), &destination)?;
    }

    Ok(destination)
}

pub(crate) fn adopt(legacy: &Path, destination: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(destination)?;

    let entries = match std::fs::read_dir(legacy) {
        Ok(entries) => entries,
        Err(_) => return Ok(()),
    };

    for entry in entries.flatten() {
        if !entry.file_type().map(|kind| kind.is_file()).unwrap_or(false) {
            continue;
        }
        let target = destination.join(entry.file_name());
        if target.exists() {
            continue;
        }
        let source = entry.path();
        std::fs::rename(&source, &target).or_else(|_| {
            std::fs::copy(&source, &target)?;
            std::fs::remove_file(&source)
        })?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    struct Fixture {
        root: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let root = std::env::temp_dir().join(format!(
                "assistant-data-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::SeqCst)
            ));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(&root).expect("root");
            Self { root }
        }

        fn path(&self, name: &str) -> PathBuf {
            self.root.join(name)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn write(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("parent");
        }
        std::fs::write(path, contents).expect("write");
    }

    #[test]
    fn the_assistant_keeps_its_files_under_the_app_data_directory() {
        let fixture = Fixture::new();
        let app_data = fixture.path("app");

        assert_eq!(
            data_directory(&app_data, None),
            app_data.join("data").join("assistant")
        );
    }

    #[test]
    fn the_override_replaces_the_app_data_directory() {
        let fixture = Fixture::new();
        let elsewhere = fixture.path("elsewhere");

        assert_eq!(
            data_directory(&fixture.path("app"), Some(&elsewhere.to_string_lossy())),
            elsewhere
        );
    }

    #[test]
    fn an_empty_override_falls_back_to_the_app_data_directory() {
        let fixture = Fixture::new();
        let app_data = fixture.path("app");

        assert_eq!(data_directory(&app_data, Some("   ")), app_data.join("data").join("assistant"));
    }

    #[test]
    fn the_provider_from_the_old_location_survives_the_upgrade() {
        let fixture = Fixture::new();
        let legacy = fixture.path("temp");
        let destination = fixture.path("app/data/assistant");
        write(&legacy.join("provider.json"), "{\"baseUrl\":\"https://x\",\"model\":\"m\"}");

        adopt(&legacy, &destination).expect("adopt");

        assert_eq!(
            std::fs::read_to_string(destination.join("provider.json")).expect("moved"),
            "{\"baseUrl\":\"https://x\",\"model\":\"m\"}"
        );
        assert!(!legacy.join("provider.json").exists());
    }

    #[test]
    fn a_newer_file_at_the_destination_is_not_overwritten() {
        let fixture = Fixture::new();
        let legacy = fixture.path("temp");
        let destination = fixture.path("app/data/assistant");
        write(&legacy.join("provider.json"), "old");
        write(&destination.join("provider.json"), "new");

        adopt(&legacy, &destination).expect("adopt");

        assert_eq!(
            std::fs::read_to_string(destination.join("provider.json")).expect("kept"),
            "new"
        );
    }

    #[test]
    fn a_missing_old_location_still_creates_the_destination() {
        let fixture = Fixture::new();
        let destination = fixture.path("app/data/assistant");

        adopt(&fixture.path("nothing-here"), &destination).expect("no-op");

        assert!(destination.is_dir());
    }

    #[test]
    fn directories_in_the_old_location_are_left_alone() {
        let fixture = Fixture::new();
        let legacy = fixture.path("temp");
        let destination = fixture.path("app/data/assistant");
        std::fs::create_dir_all(legacy.join("nested")).expect("nested");
        write(&legacy.join("provider.json"), "kept");

        adopt(&legacy, &destination).expect("adopt");

        assert!(legacy.join("nested").is_dir());
        assert!(destination.join("provider.json").is_file());
    }

    #[test]
    fn an_isolated_run_never_touches_the_real_temp_directory() {
        let fixture = Fixture::new();
        let real_legacy = legacy_data_directory();
        let probe = real_legacy.join("provider.json");
        let existed = probe.exists();
        let before = std::fs::read(&probe).ok();

        let override_dir = fixture.path("isolated");
        let resolved = resolve_with(&fixture.path("app"), Some(&override_dir.to_string_lossy())).expect("resolve");

        assert_eq!(resolved, override_dir);
        assert_eq!(probe.exists(), existed);
        assert_eq!(std::fs::read(&probe).ok(), before);
    }
}
