use std::collections::BTreeSet;

use serde_json::Value as JsonValue;
use toml::Value as TomlValue;

const LOCAL_CAPABILITY: &str = include_str!("../capabilities/default.json");
const REMOTE_CAPABILITY: &str = include_str!("../capabilities/runtime-ui.json");
const DESKTOP_PERMISSIONS: &str = include_str!("../permissions/desktop.toml");

#[test]
fn bundled_shell_acl_stays_local_and_minimal() {
    let capability: JsonValue = serde_json::from_str(LOCAL_CAPABILITY).unwrap();
    assert_eq!(capability["local"], true);
    assert!(capability.get("remote").is_none());
    assert_eq!(
        string_set(&capability["windows"]),
        string_set_from(["main", "menu-bar"])
    );
    assert!(string_set(&capability["permissions"]).contains("local-shell"));

    assert_eq!(
        permission_commands("local-shell"),
        string_set_from([
            "desktop_runtime_restart",
            "desktop_runtime_status",
            "open_main_window",
            "quit_nexum",
        ])
    );
}

#[test]
fn runtime_ui_acl_allows_the_required_loopback_bridge_only() {
    let capability: JsonValue = serde_json::from_str(REMOTE_CAPABILITY).unwrap();
    assert_eq!(capability["local"], false);
    assert_eq!(
        string_set(&capability["windows"]),
        string_set_from(["main"])
    );
    assert_eq!(
        string_set(&capability["remote"]["urls"]),
        string_set_from(["http://127.0.0.1:*/*"])
    );
    let capability_permissions = string_set(&capability["permissions"]);
    assert!(capability_permissions.contains("remote-runtime-ui"));
    assert!(!capability_permissions.contains("local-shell"));

    assert_eq!(
        permission_commands("remote-runtime-ui"),
        string_set_from([
            "daemon_request",
            "desktop_runtime_restart",
            "desktop_runtime_status",
            "pick_project_folder",
            "set_desktop_theme",
            "show_system_notification",
            "start_main_window_drag",
        ])
    );
}

fn permission_commands(identifier: &str) -> BTreeSet<String> {
    let document: TomlValue = toml::from_str(DESKTOP_PERMISSIONS).unwrap();
    document["permission"]
        .as_array()
        .unwrap()
        .iter()
        .find(|permission| permission["identifier"].as_str() == Some(identifier))
        .unwrap_or_else(|| panic!("missing permission {identifier}"))["commands"]["allow"]
        .as_array()
        .unwrap()
        .iter()
        .map(|command| command.as_str().unwrap().to_owned())
        .collect()
}

fn string_set(value: &JsonValue) -> BTreeSet<String> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item.as_str().unwrap().to_owned())
        .collect()
}

fn string_set_from<const N: usize>(values: [&str; N]) -> BTreeSet<String> {
    values.into_iter().map(str::to_owned).collect()
}
