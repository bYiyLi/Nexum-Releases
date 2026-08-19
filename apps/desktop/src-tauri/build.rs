fn main() {
    println!("cargo:rerun-if-changed=permissions/desktop.toml");
    tauri_build::build()
}
