use std::path::{Path, PathBuf};

/// Where the assistant keeps its own files (the provider settings and the
/// resume text it sends along). These belong with the rest of the app's data,
/// not in the temp directory the system is free to clear.
pub(crate) fn data_directory(app_data: &Path) -> PathBuf {
    match std::env::var("REACTIVE_RESUME_DATA_DIR") {
        Ok(directory) if !directory.trim().is_empty() => PathBuf::from(directory),
        _ => app_data.join("data").join("assistant"),
    }
}

/// The directory older builds wrote to. Its contents are moved into the new
/// home the first time the app looks for them, so an upgrade keeps the
/// provider the user had already configured.
pub(crate) fn legacy_data_directory() -> PathBuf {
    std::env::temp_dir().join("reactive-resume-data")
}

/// Move anything the old location still holds into the new one. A file already
/// present at the destination wins, since it is the newer write.
pub(crate) fn adopt_legacy_data(legacy: &Path, destination: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(destination)?;

    let entries = match std::fs::read_dir(legacy) {
        Ok(entries) => entries,
        Err(_) => return Ok(()),
    };

    for entry in entries.flatten() {
        let source = entry.path();
        if !entry.file_type().map(|kind| kind.is_file()).unwrap_or(false) {
            continue;
        }
        let target = destination.join(entry.file_name());
        if target.exists() {
            continue;
        }
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
        std::env::remove_var("REACTIVE_RESUME_DATA_DIR");

        let resolved = data_directory(&app_data);

        assert_eq!(resolved, app_data.join("data").join("assistant"));
    }

    #[test]
    fn the_override_still_wins_so_tests_can_isolate_themselves() {
        let fixture = Fixture::new();
        let elsewhere = fixture.path("elsewhere");
        std::env::set_var("REACTIVE_RESUME_DATA_DIR", &elsewhere);

        let resolved = data_directory(&fixture.path("app"));

        std::env::remove_var("REACTIVE_RESUME_DATA_DIR");
        assert_eq!(resolved, elsewhere);
    }

    #[test]
    fn an_empty_override_is_ignored() {
        let fixture = Fixture::new();
        std::env::set_var("REACTIVE_RESUME_DATA_DIR", "   ");

        let resolved = data_directory(&fixture.path("app"));

        std::env::remove_var("REACTIVE_RESUME_DATA_DIR");
        assert_eq!(resolved, fixture.path("app").join("data").join("assistant"));
    }

    #[test]
    fn the_provider_from_the_old_location_survives_the_upgrade() {
        let fixture = Fixture::new();
        let legacy = fixture.path("temp");
        let destination = fixture.path("app/data/assistant");
        write(&legacy.join("provider.json"), "{\"baseUrl\":\"https://x\",\"model\":\"m\"}");

        adopt_legacy_data(&legacy, &destination).expect("adopt");

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

        adopt_legacy_data(&legacy, &destination).expect("adopt");

        assert_eq!(
            std::fs::read_to_string(destination.join("provider.json")).expect("kept"),
            "new"
        );
    }

    #[test]
    fn a_missing_old_location_is_a_no_op() {
        let fixture = Fixture::new();
        let destination = fixture.path("app/data/assistant");

        adopt_legacy_data(&fixture.path("nothing-here"), &destination).expect("no-op");

        assert!(destination.is_dir());
    }

    #[test]
    fn directories_in_the_old_location_are_left_alone() {
        let fixture = Fixture::new();
        let legacy = fixture.path("temp");
        let destination = fixture.path("app/data/assistant");
        std::fs::create_dir_all(legacy.join("nested")).expect("nested");
        write(&legacy.join("provider.json"), "kept");

        adopt_legacy_data(&legacy, &destination).expect("adopt");

        assert!(legacy.join("nested").is_dir());
        assert!(destination.join("provider.json").is_file());
    }
}
