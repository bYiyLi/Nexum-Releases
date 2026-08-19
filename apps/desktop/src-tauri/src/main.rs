#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod daemon_bridge;
mod daemon_lifecycle;
#[cfg(test)]
mod ipc_acl_tests;
mod runtime_bootstrap;

use daemon_lifecycle::DesktopDaemonManager;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, PhysicalPosition, RunEvent, Theme, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

#[cfg(target_os = "macos")]
use objc2_app_kit::{NSTitlebarSeparatorStyle, NSWindow};
#[cfg(target_os = "macos")]
use tauri::menu::MenuItemKind;

const MAIN_WINDOW_LABEL: &str = "main";
const MENU_BAR_WINDOW_LABEL: &str = "menu-bar";
const MENU_OPEN_ID: &str = "open-nexum";
const MENU_QUIT_ID: &str = "quit-nexum";
const APP_QUIT_ID: &str = "app-quit-nexum";

fn reveal_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub(crate) fn reveal_runtime_ui(app: &tauri::AppHandle) {
    let origin = match app.state::<DesktopDaemonManager>().ready_origin() {
        Ok(origin) => origin,
        Err(_) => {
            reveal_main_window(app);
            return;
        }
    };
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        if let Ok(url) = Url::parse(&format!("{origin}/")) {
            let _ = window.navigate(url);
        }
    }
    reveal_main_window(app);
}

fn hide_menu_bar_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(MENU_BAR_WINDOW_LABEL) {
        let _ = window.hide();
    }
}

fn toggle_menu_bar_window(app: &tauri::AppHandle, position: PhysicalPosition<f64>) {
    let Some(window) = app.get_webview_window(MENU_BAR_WINDOW_LABEL) else {
        return;
    };

    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
        return;
    }

    let x = (position.x - 344.0).round() as i32;
    let y = (position.y + 12.0).round() as i32;
    let _ = window.set_position(PhysicalPosition::new(x, y));
    let _ = window.show();
    let _ = window.set_focus();
}

fn setup_menu_bar_window(app: &mut tauri::App) -> tauri::Result<()> {
    let _window = WebviewWindowBuilder::new(
        app,
        MENU_BAR_WINDOW_LABEL,
        WebviewUrl::App("index.html?surface=menu-bar".into()),
    )
    .title("Nexum Menu Bar")
    .inner_size(360.0, 420.0)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .decorations(false)
    .transparent(true)
    .background_color(tauri::webview::Color(0, 0, 0, 0))
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(false)
    .visible(false)
    .build()?;

    #[cfg(target_os = "macos")]
    {
        let raw = _window.ns_window()?;
        unsafe {
            let ns_window = &*(raw.cast::<NSWindow>());
            ns_window.setHasShadow(false);
            ns_window.setOpaque(false);
        }
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn remove_titlebar_separator(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };

    let Ok(raw) = window.ns_window() else {
        return;
    };

    unsafe {
        let ns_window = &*(raw.cast::<NSWindow>());
        ns_window.setTitlebarSeparatorStyle(NSTitlebarSeparatorStyle::None);
    }
}

fn setup_menu_bar(app: &mut tauri::App) -> tauri::Result<()> {
    let version = app.package_info().version.to_string();
    let status = MenuItem::with_id(
        app,
        "nexum-status",
        format!("Nexum · v{version}"),
        false,
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let open = MenuItem::with_id(
        app,
        MENU_OPEN_ID,
        "打开 Nexum / Open Nexum",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(
        app,
        MENU_QUIT_ID,
        "退出 Nexum / Quit Nexum",
        true,
        Some("CmdOrCtrl+Q"),
    )?;
    let menu = Menu::with_items(app, &[&status, &separator, &open, &quit])?;

    let mut tray = TrayIconBuilder::with_id("nexum-menu-bar")
        .tooltip("Nexum")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_OPEN_ID => {
                hide_menu_bar_window(app);
                reveal_main_window(app);
            }
            MENU_QUIT_ID => quit_application(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                position,
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_menu_bar_window(tray.app_handle(), position);
            }
        });

    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }

    tray.build(app)?;
    Ok(())
}

fn setup_application_menu(app: &mut tauri::App) -> tauri::Result<()> {
    let menu = Menu::default(app.handle())?;
    #[cfg(target_os = "macos")]
    if let Some(MenuItemKind::Submenu(application_menu)) = menu.items()?.first() {
        let items = application_menu.items()?;
        if !items.is_empty() {
            application_menu.remove_at(items.len() - 1)?;
        }
        let quit = MenuItem::with_id(app, APP_QUIT_ID, "Quit Nexum", true, Some("CmdOrCtrl+Q"))?;
        application_menu.append(&quit)?;
    }
    app.set_menu(menu)?;
    Ok(())
}

#[tauri::command]
fn open_main_window(app: tauri::AppHandle) {
    hide_menu_bar_window(&app);
    reveal_main_window(&app);
}

#[tauri::command]
fn start_main_window_drag(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "main window is unavailable".to_string())?;
    window.start_dragging().map_err(|error| error.to_string())
}

#[tauri::command]
fn set_desktop_theme(app: tauri::AppHandle, theme: String) -> Result<(), String> {
    let native_theme = match theme.as_str() {
        "light" => Theme::Light,
        "dark" => Theme::Dark,
        value => return Err(format!("unsupported theme: {value}")),
    };

    for label in [MAIN_WINDOW_LABEL, MENU_BAR_WINDOW_LABEL] {
        if let Some(window) = app.get_webview_window(label) {
            window
                .set_theme(Some(native_theme))
                .map_err(|error| error.to_string())?;
        }
    }

    Ok(())
}

#[tauri::command]
async fn pick_project_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    app.dialog()
        .file()
        .blocking_pick_folder()
        .map(|path| {
            path.into_path()
                .map(|path| path.to_string_lossy().into_owned())
                .map_err(|error| error.to_string())
        })
        .transpose()
}

#[tauri::command]
fn show_system_notification(
    app: tauri::AppHandle,
    title: String,
    body: String,
) -> Result<bool, String> {
    let notifications = app.notification();
    let permission = notifications
        .request_permission()
        .map_err(|error| error.to_string())?;
    if permission != tauri::plugin::PermissionState::Granted {
        return Ok(false);
    }
    notifications
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|error| error.to_string())?;
    Ok(true)
}

#[tauri::command]
fn quit_nexum(app: tauri::AppHandle) {
    quit_application(&app);
}

fn quit_application(app: &tauri::AppHandle) {
    let _ = app.save_window_state(StateFlags::SIZE | StateFlags::POSITION);
    if let Err(error) = app.state::<DesktopDaemonManager>().shutdown_owned() {
        eprintln!("[nexum] Desktop-owned Daemon shutdown failed: {error}");
    }
    app.exit(0);
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::SIZE | StateFlags::POSITION)
                .with_filter(|label| label == MAIN_WINDOW_LABEL)
                .build(),
        )
        .on_menu_event(|app, event| {
            if event.id().as_ref() == APP_QUIT_ID {
                quit_application(app);
            }
        })
        .setup(|app| {
            app.manage(DesktopDaemonManager::new());
            setup_application_menu(app)?;
            setup_menu_bar_window(app)?;
            setup_menu_bar(app)?;
            #[cfg(target_os = "macos")]
            remove_titlebar_separator(app.handle());
            DesktopDaemonManager::initialize_background(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_main_window,
            start_main_window_drag,
            set_desktop_theme,
            pick_project_folder,
            show_system_notification,
            daemon_bridge::desktop_runtime_status,
            daemon_bridge::desktop_runtime_restart,
            daemon_bridge::daemon_request,
            quit_nexum
        ])
        .on_window_event(|window, event| match (window.label(), event) {
            (MAIN_WINDOW_LABEL, WindowEvent::CloseRequested { api, .. }) => {
                api.prevent_close();
                let _ = window
                    .app_handle()
                    .save_window_state(StateFlags::SIZE | StateFlags::POSITION);
                let _ = window.hide();
            }
            (MENU_BAR_WINDOW_LABEL, WindowEvent::CloseRequested { api, .. }) => {
                api.prevent_close();
                let _ = window.hide();
            }
            (MENU_BAR_WINDOW_LABEL, WindowEvent::Focused(false)) => {
                let _ = window.hide();
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("failed to build Nexum Desktop");

    app.run(|app, event| {
        if let RunEvent::ExitRequested { .. } = event {
            let _ = app.state::<DesktopDaemonManager>().shutdown_owned();
        }
        match event {
            RunEvent::Ready => reveal_runtime_ui(app),
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => reveal_runtime_ui(app),
            _ => {}
        }
    });
}
