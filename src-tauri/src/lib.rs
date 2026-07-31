mod sidecar;

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, RunEvent, WindowEvent, Wry,
};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_positioner::{Position, WindowExt};
use tauri_plugin_updater::UpdaterExt;

use sidecar::{server_port, Sidecar, DEFAULT_PORT};

/// Records when the popover was last dismissed by losing focus. A click on the
/// tray icon while the popover is open blurs (and hides) it *before* the tray
/// event fires — without this guard the tray handler would immediately re-open
/// it, so a click meant to close it would feel like nothing happened.
struct BlurGuard(Mutex<Instant>);

fn dashboard_url() -> String {
    format!("http://localhost:{}", server_port())
}

/// Self-update from GitHub Releases (latest.json + tauri-signed .app.tar.gz).
///
/// Two modes share this function. On launch (`install = false`) it only looks:
/// an available update turns the menu item into "Install update vX.Y.Z…" and
/// nothing happens until the user clicks it — auto-replacing the app under
/// someone mid-thought is not this app's style. On click (`install = true`) it
/// downloads, verifies against the baked-in pubkey, swaps the .app, and
/// restarts. Every failure lands in the menu item text, because a menubar app
/// has no other honest place to report it.
fn spawn_update_check(app: AppHandle, item: MenuItem<Wry>, install: bool) {
    tauri::async_runtime::spawn(async move {
        let updater = match app.updater() {
            Ok(u) => u,
            Err(err) => {
                log::warn!("updater unavailable: {err}");
                let _ = item.set_text("Updates unavailable");
                return;
            }
        };
        if install {
            let _ = item.set_text("Checking for updates…");
        }
        match updater.check().await {
            Ok(Some(update)) => {
                if !install {
                    let _ = item.set_text(format!("Install update v{}…", update.version));
                    return;
                }
                let _ = item.set_text(format!("Installing v{}…", update.version));
                match update.download_and_install(|_, _| {}, || {}).await {
                    Ok(()) => {
                        log::info!("update v{} installed, restarting", update.version);
                        app.restart();
                    }
                    Err(err) => {
                        log::error!("update install failed: {err}");
                        let _ = item.set_text("Update failed — try again later");
                    }
                }
            }
            Ok(None) => {
                if install {
                    let _ = item.set_text(format!("Up to date (v{})", app.package_info().version));
                }
            }
            Err(err) => {
                // Expected before the first updater-enabled release exists, and
                // whenever the machine is offline — quiet unless the user asked.
                log::warn!("update check failed: {err}");
                if install {
                    let _ = item.set_text("Update check failed — offline?");
                }
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_positioner::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
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

            // The app owns the server's lifetime now — no launchd job, no
            // `npm run dev` required, and no absolute path to go stale when the
            // repo moves. That staleness is what killed the previous setup.
            let state = sidecar::start(app.handle());
            app.manage(Sidecar(Mutex::new(state)));
            let sidecar = app.state::<Sidecar>();

            // The window URL in tauri.conf.json is static; on a custom port the
            // popover has to be pointed at the right server by hand.
            if server_port() != DEFAULT_PORT {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.navigate(dashboard_url().parse()?);
                }
            }

            let status_i =
                MenuItem::with_id(app, "status", sidecar.status_line(), false, None::<&str>)?;
            let open_i = MenuItem::with_id(app, "open", "Open in browser", true, None::<&str>)?;
            let autostart_enabled = app.autolaunch().is_enabled().unwrap_or(false);
            let autostart_i = CheckMenuItem::with_id(
                app,
                "autostart",
                "Launch at login",
                true,
                autostart_enabled,
                None::<&str>,
            )?;
            let update_i =
                MenuItem::with_id(app, "update", "Check for Updates…", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit Central Brain", true, None::<&str>)?;
            let menu =
                Menu::with_items(app, &[&status_i, &open_i, &autostart_i, &update_i, &quit_i])?;

            // A silent look at launch: if a release is out, the menu item says
            // so, and installing stays the user's click to make.
            spawn_update_check(app.handle().clone(), update_i.clone(), false);

            // Surface an unhealthy server in the tooltip. Previously a dead
            // server just produced a blank popover with no explanation — a
            // status dashboard that could not report its own status.
            let tooltip = if sidecar.is_healthy() {
                "Central Brain".to_string()
            } else {
                format!("Central Brain — {}", sidecar.status_line())
            };

            TrayIconBuilder::with_id("central-brain-tray")
                // A dedicated monochrome mark, NOT the app icon. The menubar
                // was showing `default_window_icon()` — a full-colour square
                // that macOS cannot tint, so it ignored the light/dark menubar
                // and sat there as the stock Tauri logo. A template image is
                // black + alpha; the system inverts and dims it to match.
                .icon(tauri::include_image!("icons/trayTemplate.png"))
                .icon_as_template(true)
                .tooltip(tooltip)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "open" => {
                        let _ = std::process::Command::new("open")
                            .arg(dashboard_url())
                            .spawn();
                    }
                    "update" => {
                        spawn_update_check(app.clone(), update_i.clone(), true);
                    }
                    "autostart" => {
                        // The plugin registers a Launch Agent pointing at the
                        // installed .app bundle, not a path into a checkout —
                        // repo moves can't strand it the way the old launchd
                        // service was stranded.
                        let autolaunch = app.autolaunch();
                        let enabled = autolaunch.is_enabled().unwrap_or(false);
                        let result = if enabled {
                            autolaunch.disable()
                        } else {
                            autolaunch.enable()
                        };
                        match result {
                            Ok(()) => {
                                let _ = autostart_i.set_checked(!enabled);
                            }
                            Err(err) => {
                                log::error!("autostart toggle failed: {err}");
                                let _ = autostart_i.set_checked(enabled);
                            }
                        }
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

                        // Don't open a popover onto a dead port — it renders
                        // blank and looks like the app itself is broken. Put the
                        // real reason in the tooltip instead.
                        if !sidecar::server_is_up() {
                            let reason = app
                                .try_state::<Sidecar>()
                                .map(|s| s.status_line())
                                .unwrap_or_else(|| "server not running".to_string());
                            if let Some(tray) = app.tray_by_id("central-brain-tray") {
                                let _ =
                                    tray.set_tooltip(Some(format!("Central Brain — {reason}")));
                            }
                            log::warn!("tray click ignored: {reason}");
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
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        // One process tree: the server dies with the app rather than outliving it
        // as an orphan holding port 4317. Only a server we spawned is killed — an
        // attached one (someone's `npm run dev`) is left running.
        if let RunEvent::Exit = event {
            if let Some(sidecar) = handle.try_state::<Sidecar>() {
                sidecar.shutdown();
            }
        }
    });
}
