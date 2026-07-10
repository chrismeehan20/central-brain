use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};
use tauri_plugin_positioner::{Position, WindowExt};

const DASHBOARD_URL: &str = "http://localhost:4317";

/// Records when the popover was last dismissed by losing focus. A click on the
/// tray icon while the popover is open blurs (and hides) it *before* the tray
/// event fires — without this guard the tray handler would immediately re-open
/// it, so a click meant to close it would feel like nothing happened.
struct BlurGuard(Mutex<Instant>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_positioner::init())
        .manage(BlurGuard(Mutex::new(Instant::now() - Duration::from_secs(1))))
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Menu-bar-only app: no Dock icon, no app-switcher entry.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let open_i = MenuItem::with_id(app, "open", "Open in browser", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit Central Brain", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_i, &quit_i])?;

            TrayIconBuilder::with_id("central-brain-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Central Brain")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "open" => {
                        let _ = std::process::Command::new("open").arg(DASHBOARD_URL).spawn();
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    let app = tray.app_handle();
                    tauri_plugin_positioner::on_tray_event(app, &event);

                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        // Swallow the click that just dismissed the popover via blur.
                        let just_dismissed = app
                            .try_state::<BlurGuard>()
                            .map(|g| g.0.lock().unwrap().elapsed() < Duration::from_millis(250))
                            .unwrap_or(false);
                        if just_dismissed {
                            return;
                        }

                        if let Some(win) = app.get_webview_window("main") {
                            if win.is_visible().unwrap_or(false) {
                                let _ = win.hide();
                            } else {
                                let _ = win.move_window(Position::TrayCenter);
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // Click-away to dismiss the popover.
            if let WindowEvent::Focused(false) = event {
                if window.label() == "main" {
                    if let Some(guard) = window.try_state::<BlurGuard>() {
                        *guard.0.lock().unwrap() = Instant::now();
                    }
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
