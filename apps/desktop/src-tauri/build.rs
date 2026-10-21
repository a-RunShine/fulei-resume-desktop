use std::path::Path;

fn main() {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").expect("manifest directory");
    let runtime = Path::new(&manifest)
        .join("..")
        .join(".cache")
        .join("installer")
        .join("runtime");
    let packaging = std::env::var("REACTIVE_RESUME_PACKAGING").is_ok_and(|value| value == "1");
    for name in ["node", "server", "web"] {
        let directory = runtime.join(name);
        if packaging {
            assert!(
                directory.is_dir(),
                "the installer runtime is not staged: {}",
                directory.display()
            );
        }
        let _ = std::fs::create_dir_all(directory);
    }
    tauri_build::build()
}
