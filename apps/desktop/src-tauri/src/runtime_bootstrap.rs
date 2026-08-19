use std::env;
use std::path::{Path, PathBuf};

pub struct RuntimeInstallation {
    pub root: PathBuf,
    pub node: PathBuf,
}

pub fn bundled_runtime(resource_dir: &Path) -> Result<RuntimeInstallation, String> {
    let root = resource_dir.join("runtime");
    let node = resource_dir
        .join("bootstrap")
        .join(if cfg!(windows) { "node.exe" } else { "node" });

    if !node.is_file() {
        return Err(format!(
            "Desktop Node bootstrap is missing: {}",
            node.display()
        ));
    }
    if !runtime_is_complete(&root) {
        return Err(format!(
            "Embedded Nexum Runtime is incomplete: {}",
            root.display()
        ));
    }

    Ok(RuntimeInstallation { root, node })
}

pub fn profile_config_path() -> Result<PathBuf, String> {
    let home = user_home()?;
    Ok(home
        .join(if cfg!(debug_assertions) {
            ".nexum-dev"
        } else {
            ".nexum"
        })
        .join("config.toml"))
}

fn user_home() -> Result<PathBuf, String> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| "User home is unavailable.".to_string())
}

fn runtime_is_complete(root: &Path) -> bool {
    root.join("dist/main.js").is_file()
        && root.join("web/index.html").is_file()
        && root.join("nexum-runtime.json").is_file()
        && root.join("embedded-runtime.json").is_file()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn embedded_runtime_requires_all_release_markers() {
        let root = temp_root("runtime-complete");
        fs::create_dir_all(root.join("dist")).expect("runtime dist");
        fs::create_dir_all(root.join("web")).expect("runtime web");
        fs::write(root.join("dist/main.js"), "main").expect("runtime entry");
        fs::write(root.join("web/index.html"), "<div id=\"root\"></div>")
            .expect("runtime web index");
        fs::write(root.join("nexum-runtime.json"), "{}").expect("runtime manifest");

        assert!(!runtime_is_complete(&root));
        fs::write(root.join("embedded-runtime.json"), "{}").expect("embedded marker");
        assert!(runtime_is_complete(&root));
        fs::remove_dir_all(root).expect("cleanup embedded runtime test");
    }

    fn temp_root(name: &str) -> PathBuf {
        env::temp_dir().join(format!(
            "nexum-{name}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ))
    }
}
