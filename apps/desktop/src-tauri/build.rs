use std::path::Path;

fn main() {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").expect("manifest directory");
    let runtime = Path::new(&manifest).join("..").join(".cache").join("installer").join("runtime");
    for name in ["node", "server", "web"] {
        let _ = std::fs::create_dir_all(runtime.join(name));
    }
    tauri_build::build()
}
