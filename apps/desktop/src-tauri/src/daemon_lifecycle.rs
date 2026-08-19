use crate::runtime_bootstrap;
use reqwest::blocking::Client as BlockingClient;
use serde::{Deserialize, Serialize};
use std::fs;
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const DEFAULT_DAEMON_PORT: u16 = 38_400;
const DEVELOPMENT_DAEMON_PORT: u16 = 38_401;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(12);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(4);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRuntimeStatus {
    pub state: &'static str,
    pub ownership: &'static str,
    pub origin: String,
    pub version: Option<String>,
    pub error: Option<String>,
}

struct LifecycleState {
    child: Option<Child>,
    status: DesktopRuntimeStatus,
}

pub struct DesktopDaemonManager {
    inner: Mutex<LifecycleState>,
    operation: Mutex<()>,
    shutdown_requested: AtomicBool,
}

impl DesktopDaemonManager {
    pub fn new() -> Self {
        let origin = daemon_origin()
            .unwrap_or_else(|_| format!("http://127.0.0.1:{}", default_daemon_port()));
        Self {
            inner: Mutex::new(LifecycleState {
                child: None,
                status: DesktopRuntimeStatus {
                    state: "starting",
                    ownership: "none",
                    origin,
                    version: None,
                    error: None,
                },
            }),
            operation: Mutex::new(()),
            shutdown_requested: AtomicBool::new(false),
        }
    }

    pub fn initialize_background(app: AppHandle) {
        thread::spawn(move || {
            let manager = app.state::<DesktopDaemonManager>();
            let ready = {
                let _operation = manager.operation.lock().expect("daemon operation poisoned");
                if manager.shutdown_requested.load(Ordering::Acquire) {
                    return;
                }

                let origin = match daemon_origin() {
                    Ok(origin) => origin,
                    Err(error) => {
                        let mut state = manager.inner.lock().expect("daemon state poisoned");
                        *state = failed_state("unavailable", "none", error);
                        return;
                    }
                };
                let mut initialized =
                    initialize_lifecycle(&app, &origin, &manager.shutdown_requested);
                if manager.shutdown_requested.load(Ordering::Acquire) {
                    let _ = stop_owned_child(&mut initialized);
                    initialized.status = stopped_status(&origin);
                    let mut state = manager.inner.lock().expect("daemon state poisoned");
                    *state = initialized;
                    return;
                }
                let ready = initialized.status.state == "ready";
                let mut state = manager.inner.lock().expect("daemon state poisoned");
                *state = initialized;
                ready
            };
            if ready {
                let app_for_ui = app.clone();
                let _ = app.run_on_main_thread(move || {
                    crate::reveal_runtime_ui(&app_for_ui);
                });
            }
        });
    }

    pub fn status(&self) -> DesktopRuntimeStatus {
        let mut state = self.inner.lock().expect("daemon state poisoned");
        refresh_owned_child(&mut state);
        state.status.clone()
    }

    pub fn ready_origin(&self) -> Result<String, String> {
        let mut state = self.inner.lock().map_err(|_| "Daemon state unavailable")?;
        refresh_owned_child(&mut state);
        if state.status.state == "ready" {
            Ok(state.status.origin.clone())
        } else {
            Err(state
                .status
                .error
                .clone()
                .unwrap_or_else(|| "Nexum Daemon is unavailable.".to_string()))
        }
    }

    pub fn shutdown_owned(&self) -> Result<(), String> {
        self.shutdown_requested.store(true, Ordering::Release);
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "Daemon operation unavailable")?;
        let mut state = self.inner.lock().map_err(|_| "Daemon state unavailable")?;
        stop_owned_child(&mut state)?;
        state.status = stopped_status(&state.status.origin);
        Ok(())
    }

    pub fn restart_owned(&self, app: &AppHandle) -> Result<DesktopRuntimeStatus, String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "Daemon operation unavailable")?;
        if self.shutdown_requested.load(Ordering::Acquire) {
            return Err("Nexum Desktop is shutting down.".to_string());
        }
        let origin = daemon_origin()?;
        let mut state = self.inner.lock().map_err(|_| "Daemon state unavailable")?;
        refresh_owned_child(&mut state);
        if state.status.ownership == "external" {
            return Err("External Nexum Daemon is not owned by Desktop.".to_string());
        }
        stop_owned_child(&mut state)?;
        drop(state);
        let next = start_bundled_runtime(app, &origin, &self.shutdown_requested);
        let status = next.status.clone();
        let mut state = self.inner.lock().map_err(|_| "Daemon state unavailable")?;
        *state = next;
        if status.state == "ready" {
            Ok(status)
        } else {
            Err(runtime_status_error(&status))
        }
    }
}

fn stop_owned_child(state: &mut LifecycleState) -> Result<(), String> {
    let Some(mut child) = state.child.take() else {
        return Ok(());
    };
    if let Err(error) = terminate_gracefully(&mut child) {
        state.child = Some(child);
        state.status.state = "error";
        state.status.error = Some(format!(
            "Failed to stop Desktop-owned Nexum Daemon: {error}"
        ));
        return Err(error);
    }
    state.status.state = "stopped";
    state.status.error = None;
    Ok(())
}

fn start_bundled_runtime(
    app: &AppHandle,
    origin: &str,
    shutdown_requested: &AtomicBool,
) -> LifecycleState {
    match daemon_launch_spec(app) {
        Ok(launch) => start_launch(launch, origin, shutdown_requested),
        Err(error) => failed_state(origin, "none", error),
    }
}

fn runtime_status_error(status: &DesktopRuntimeStatus) -> String {
    status
        .error
        .clone()
        .unwrap_or_else(|| "Nexum Runtime is unavailable.".to_string())
}

fn refresh_owned_child(state: &mut LifecycleState) {
    let Some(child) = state.child.as_mut() else {
        return;
    };
    match child.try_wait() {
        Ok(Some(status)) => {
            state.child = None;
            state.status.state = "error";
            state.status.error = Some(format!(
                "Desktop-owned Nexum Daemon exited unexpectedly: {status}"
            ));
        }
        Ok(None) => {}
        Err(error) => {
            state.status.state = "error";
            state.status.error = Some(format!(
                "Failed to inspect Desktop-owned Nexum Daemon: {error}"
            ));
        }
    }
}

#[derive(Deserialize)]
struct HealthPayload {
    service: String,
    status: String,
    version: String,
}

#[derive(Deserialize)]
struct ConfigFile {
    daemon: Option<DaemonConfig>,
}

#[derive(Deserialize)]
struct DaemonConfig {
    port: Option<u16>,
}

enum ProbeResult {
    Absent,
    Compatible(String),
    Conflict(String),
}

fn initialize_lifecycle(
    app: &AppHandle,
    origin: &str,
    shutdown_requested: &AtomicBool,
) -> LifecycleState {
    match probe_daemon(origin) {
        ProbeResult::Compatible(version) => ready_state(origin, "external", version, None),
        ProbeResult::Conflict(error) => failed_state(origin, "external", error),
        ProbeResult::Absent => spawn_owned_daemon(app, origin, shutdown_requested),
    }
}

fn spawn_owned_daemon(
    app: &AppHandle,
    origin: &str,
    shutdown_requested: &AtomicBool,
) -> LifecycleState {
    let launch = match daemon_launch_spec(app) {
        Ok(launch) => launch,
        Err(error) => return failed_state(origin, "none", error),
    };
    start_launch(launch, origin, shutdown_requested)
}

fn start_launch(
    launch: LaunchSpec,
    origin: &str,
    shutdown_requested: &AtomicBool,
) -> LifecycleState {
    if shutdown_requested.load(Ordering::Acquire) {
        return LifecycleState {
            child: None,
            status: stopped_status(origin),
        };
    }
    let mut command = Command::new(&launch.node);
    command.arg(&launch.script);
    command.args(&launch.args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = match command
        .current_dir(&launch.working_directory)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            return failed_state(
                origin,
                "none",
                format!("Failed to start Nexum Runtime Daemon: {error}"),
            )
        }
    };

    let deadline = Instant::now() + STARTUP_TIMEOUT;
    while Instant::now() < deadline {
        if shutdown_requested.load(Ordering::Acquire) {
            let _ = terminate_gracefully(&mut child);
            return LifecycleState {
                child: None,
                status: stopped_status(origin),
            };
        }
        match probe_daemon(origin) {
            ProbeResult::Compatible(version) => {
                if child.try_wait().ok().flatten().is_some() {
                    return ready_state(origin, "external", version, None);
                }
                return ready_state(origin, "desktop", version, Some(child));
            }
            ProbeResult::Conflict(error) => {
                let _ = terminate_gracefully(&mut child);
                return failed_state(origin, "none", error);
            }
            ProbeResult::Absent => {}
        }
        if let Ok(Some(status)) = child.try_wait() {
            return failed_state(
                origin,
                "none",
                format!("Nexum Runtime Daemon exited before ready: {status}"),
            );
        }
        thread::sleep(Duration::from_millis(100));
    }
    let _ = terminate_gracefully(&mut child);
    failed_state(
        origin,
        "none",
        "Timed out waiting for Nexum Runtime Daemon readiness.".to_string(),
    )
}

fn probe_daemon(origin: &str) -> ProbeResult {
    let port = origin
        .rsplit_once(':')
        .and_then(|(_, port)| port.parse::<u16>().ok())
        .unwrap_or(DEFAULT_DAEMON_PORT);
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    if TcpStream::connect_timeout(&address, Duration::from_millis(180)).is_err() {
        return ProbeResult::Absent;
    }
    let client = match BlockingClient::builder()
        .timeout(Duration::from_secs(2))
        .build()
    {
        Ok(client) => client,
        Err(error) => return ProbeResult::Conflict(error.to_string()),
    };
    let response = match client.get(format!("{origin}/api/v1/health")).send() {
        Ok(response) => response,
        Err(error) => {
            return ProbeResult::Conflict(format!(
                "Port {port} is occupied but Nexum health is unavailable: {error}"
            ))
        }
    };
    if !response.status().is_success() {
        return ProbeResult::Conflict(format!(
            "Port {port} is occupied by an incompatible service (HTTP {}).",
            response.status()
        ));
    }
    let health = match response.json::<HealthPayload>() {
        Ok(health) => health,
        Err(error) => {
            return ProbeResult::Conflict(format!(
                "Port {port} is occupied but did not return Nexum health: {error}"
            ))
        }
    };
    if health.service != "nexum" {
        return ProbeResult::Conflict(format!(
            "Port {port} is occupied by an incompatible service."
        ));
    }
    if health.status != "ready" {
        return ProbeResult::Conflict(format!(
            "Nexum Daemon on port {port} is not ready ({}).",
            health.status
        ));
    }
    ProbeResult::Compatible(health.version)
}

struct LaunchSpec {
    node: PathBuf,
    script: PathBuf,
    args: Vec<String>,
    working_directory: PathBuf,
}

fn daemon_launch_spec(app: &AppHandle) -> Result<LaunchSpec, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    let runtime = runtime_bootstrap::bundled_runtime(&resource_dir)?;
    Ok(LaunchSpec {
        node: runtime.node,
        script: runtime.root.join("dist/main.js"),
        args: runtime_entrypoint_args(),
        working_directory: runtime.root,
    })
}

fn runtime_entrypoint_args() -> Vec<String> {
    vec![
        "--profile".to_string(),
        if cfg!(debug_assertions) {
            "development".to_string()
        } else {
            "production".to_string()
        },
        "start".to_string(),
    ]
}

fn daemon_origin() -> Result<String, String> {
    Ok(format!("http://127.0.0.1:{}", configured_daemon_port()?))
}

fn configured_daemon_port() -> Result<u16, String> {
    let path = runtime_bootstrap::profile_config_path()?;
    let source = match fs::read_to_string(&path) {
        Ok(source) => source,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(default_daemon_port());
        }
        Err(error) => {
            return Err(format!("Failed to read {}: {error}", path.display()));
        }
    };
    let config = toml::from_str::<ConfigFile>(&source)
        .map_err(|error| format!("Invalid {}: {error}", path.display()))?;
    Ok(config
        .daemon
        .and_then(|daemon| daemon.port)
        .unwrap_or_else(default_daemon_port))
}

fn default_daemon_port() -> u16 {
    if cfg!(debug_assertions) {
        DEVELOPMENT_DAEMON_PORT
    } else {
        DEFAULT_DAEMON_PORT
    }
}

fn ready_state(
    origin: &str,
    ownership: &'static str,
    version: String,
    child: Option<Child>,
) -> LifecycleState {
    LifecycleState {
        child,
        status: DesktopRuntimeStatus {
            state: "ready",
            ownership,
            origin: origin.to_string(),
            version: Some(version),
            error: None,
        },
    }
}

fn failed_state(origin: &str, ownership: &'static str, error: String) -> LifecycleState {
    LifecycleState {
        child: None,
        status: DesktopRuntimeStatus {
            state: "error",
            ownership,
            origin: origin.to_string(),
            version: None,
            error: Some(error),
        },
    }
}

fn stopped_status(origin: &str) -> DesktopRuntimeStatus {
    DesktopRuntimeStatus {
        state: "stopped",
        ownership: "none",
        origin: origin.to_string(),
        version: None,
        error: None,
    }
}

fn terminate_gracefully(child: &mut Child) -> Result<(), String> {
    if child
        .try_wait()
        .map_err(|error| error.to_string())?
        .is_some()
    {
        return Ok(());
    }
    #[cfg(unix)]
    unsafe {
        if libc::kill(child.id() as i32, libc::SIGTERM) != 0 {
            child.kill().map_err(|error| error.to_string())?;
            child.wait().map_err(|error| error.to_string())?;
            return Ok(());
        }
    }
    #[cfg(not(unix))]
    child.kill().map_err(|error| error.to_string())?;

    let deadline = Instant::now() + SHUTDOWN_TIMEOUT;
    while Instant::now() < deadline {
        if child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_some()
        {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(50));
    }
    child.kill().map_err(|error| error.to_string())?;
    child.wait().map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn probe_daemon_accepts_ready_nexum_service() {
        let origin = serve_health_once("0.1.0", "ready", Some(1));
        match probe_daemon(&origin) {
            ProbeResult::Compatible(version) => assert_eq!(version, "0.1.0"),
            _ => panic!("expected compatible Nexum Daemon"),
        }
    }

    #[test]
    fn runtime_entrypoint_uses_cli_start_contract() {
        let args = runtime_entrypoint_args();
        assert_eq!(args[0], "--profile");
        assert_eq!(args[2], "start");
        assert_eq!(
            args[1],
            if cfg!(debug_assertions) {
                "development"
            } else {
                "production"
            }
        );
    }

    #[test]
    fn probe_daemon_accepts_runtime_version_independent_of_shell() {
        let origin = serve_health_once("0.2.0", "ready", Some(1));
        match probe_daemon(&origin) {
            ProbeResult::Compatible(version) => assert_eq!(version, "0.2.0"),
            _ => panic!("expected version-independent Nexum Daemon attach"),
        }
    }

    #[test]
    fn probe_daemon_rejects_foreign_health_payload() {
        let origin = serve_health_once_with_service("other", "0.1.0", "ready", Some(1));
        match probe_daemon(&origin) {
            ProbeResult::Conflict(error) => assert!(error.contains("incompatible service")),
            _ => panic!("expected incompatible service conflict"),
        }
    }

    #[test]
    fn probe_daemon_reports_absent_listener() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test listener");
        let address = listener.local_addr().expect("test listener address");
        drop(listener);
        assert!(matches!(
            probe_daemon(&format!("http://{address}")),
            ProbeResult::Absent
        ));
    }

    #[test]
    fn probe_daemon_accepts_missing_management_marker() {
        let origin = serve_health_once("0.1.0", "ready", None);
        match probe_daemon(&origin) {
            ProbeResult::Compatible(version) => assert_eq!(version, "0.1.0"),
            _ => panic!("expected ready Nexum service without management marker"),
        }
    }

    #[test]
    fn probe_daemon_accepts_management_marker_difference() {
        let origin = serve_health_once("0.1.0", "ready", Some(2));
        match probe_daemon(&origin) {
            ProbeResult::Compatible(version) => assert_eq!(version, "0.1.0"),
            _ => panic!("expected ready Nexum service with different management marker"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn external_ownership_never_terminates_unowned_process() {
        let mut external = spawn_long_running_child();
        let manager = manager_with_state(ready_state(
            "http://127.0.0.1:38400",
            "external",
            "0.1.0".to_string(),
            None,
        ));
        manager.shutdown_owned().expect("external shutdown noop");
        assert!(external.try_wait().expect("read child status").is_none());
        external.kill().expect("cleanup external child");
        external.wait().expect("wait external child");
    }

    #[cfg(unix)]
    #[test]
    fn desktop_ownership_terminates_owned_process() {
        let child = spawn_long_running_child();
        let pid = child.id() as i32;
        let manager = manager_with_state(ready_state(
            "http://127.0.0.1:38400",
            "desktop",
            "0.1.0".to_string(),
            Some(child),
        ));
        manager.shutdown_owned().expect("owned shutdown");
        assert_ne!(unsafe { libc::kill(pid, 0) }, 0);
    }

    #[cfg(unix)]
    #[test]
    fn desktop_status_detects_unexpected_owned_process_exit() {
        let child = Command::new("sh")
            .arg("-c")
            .arg("exit 7")
            .spawn()
            .expect("spawn exiting child");
        let manager = manager_with_state(ready_state(
            "http://127.0.0.1:38400",
            "desktop",
            "0.1.0".to_string(),
            Some(child),
        ));
        thread::sleep(Duration::from_millis(50));
        let status = manager.status();
        assert_eq!(status.state, "error");
        assert!(status
            .error
            .expect("owned exit error")
            .contains("unexpectedly"));
    }

    #[test]
    fn cancelled_launch_does_not_spawn_runtime() {
        let shutdown_requested = AtomicBool::new(true);
        let state = start_launch(
            LaunchSpec {
                node: PathBuf::from("definitely-missing-nexum-node"),
                script: PathBuf::from("definitely-missing-runtime.js"),
                args: Vec::new(),
                working_directory: PathBuf::from("."),
            },
            "http://127.0.0.1:38400",
            &shutdown_requested,
        );
        assert_eq!(state.status.state, "stopped");
        assert!(state.child.is_none());
    }

    fn serve_health_once(
        version: &'static str,
        status: &'static str,
        local_management_api_version: Option<u32>,
    ) -> String {
        serve_health_once_with_service("nexum", version, status, local_management_api_version)
    }

    fn serve_health_once_with_service(
        service: &'static str,
        version: &'static str,
        status: &'static str,
        local_management_api_version: Option<u32>,
    ) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test listener");
        let address = listener.local_addr().expect("test listener address");
        thread::spawn(move || {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().expect("accept probe request");
                let mut buffer = [0_u8; 2048];
                let read = stream.read(&mut buffer).expect("read probe request");
                if read == 0 {
                    continue;
                }
                let management = local_management_api_version
                    .map(|value| format!(r#","localManagementApiVersion":{value}"#))
                    .unwrap_or_default();
                let body = format!(
                    r#"{{"service":"{service}","status":"{status}","version":"{version}"{management},"observability":{{"history":"ready"}}}}"#
                );
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                )
                .expect("write health response");
                break;
            }
        });
        format!("http://{address}")
    }

    #[cfg(unix)]
    fn spawn_long_running_child() -> Child {
        Command::new("sh")
            .arg("-c")
            .arg("trap 'exit 0' TERM; while :; do sleep 1; done")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn long running child")
    }

    #[cfg(unix)]
    fn manager_with_state(state: LifecycleState) -> DesktopDaemonManager {
        DesktopDaemonManager {
            inner: Mutex::new(state),
            operation: Mutex::new(()),
            shutdown_requested: AtomicBool::new(false),
        }
    }
}
