use crate::daemon_lifecycle::{DesktopDaemonManager, DesktopRuntimeStatus};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, State};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonRequest {
    method: String,
    path: String,
    body: Option<Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonResponse {
    status: u16,
    body: Value,
}

#[tauri::command]
pub fn desktop_runtime_status(daemon: State<'_, DesktopDaemonManager>) -> DesktopRuntimeStatus {
    daemon.status()
}

#[tauri::command]
pub async fn desktop_runtime_restart(app: AppHandle) -> Result<DesktopRuntimeStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let daemon = app.state::<DesktopDaemonManager>();
        daemon.restart_owned(&app)
    })
    .await
    .map_err(|error| format!("Desktop Runtime restart task failed: {error}"))?
}

#[tauri::command]
pub async fn daemon_request(
    daemon: State<'_, DesktopDaemonManager>,
    request: DaemonRequest,
) -> Result<DaemonResponse, String> {
    validate_request(&request)?;
    let origin = daemon.ready_origin()?;
    let method = reqwest::Method::from_bytes(request.method.as_bytes())
        .map_err(|_| "Unsupported Local API method.".to_string())?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(35))
        .build()
        .map_err(|error| error.to_string())?;
    let mut outgoing = client.request(method, format!("{origin}{}", request.path));
    if let Some(body) = request.body {
        outgoing = outgoing.json(&body);
    }
    let response = outgoing.send().await.map_err(|error| error.to_string())?;
    let status = response.status().as_u16();
    let body = response
        .json::<Value>()
        .await
        .map_err(|error| format!("Local API returned invalid JSON: {error}"))?;
    Ok(DaemonResponse { status, body })
}

fn validate_request(request: &DaemonRequest) -> Result<(), String> {
    if !matches!(request.method.as_str(), "GET" | "POST" | "PUT" | "DELETE") {
        return Err("Unsupported Local API method.".to_string());
    }
    if !request.path.starts_with("/api/v1/")
        || request.path.contains("://")
        || request.path.contains('\\')
    {
        return Err("Invalid Local API path.".to_string());
    }
    Ok(())
}
