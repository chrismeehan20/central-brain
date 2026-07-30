use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

pub const SERVER_PORT: u16 = 4317;

/// How long to wait for a freshly spawned server to start listening before we
/// give up and report a failure in the tray. Generous: the first scan reads
/// every Claude/Codex transcript index before the port opens.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
const PROBE_TIMEOUT: Duration = Duration::from_millis(250);

/// Absolute interpreter candidates, tried in order before falling back to PATH.
///
/// This list is the whole point of this module. A `.app` launched from Finder or
/// at login does NOT inherit a shell PATH — it gets roughly
/// `/usr/bin:/bin:/usr/sbin:/sbin` — so spawning bare `node` succeeds under
/// `tauri dev` (which inherits the developer's shell) and fails only in the
/// packaged app. That is the same invisible, packaged-path-only failure mode as
/// the stale launchd plist this sidecar replaces.
#[cfg(target_os = "macos")]
const NODE_CANDIDATES: &[&str] = &[
    "/usr/local/bin/node",
    "/opt/homebrew/bin/node",
    "/usr/bin/node",
    "/opt/local/bin/node",
];

#[cfg(not(target_os = "macos"))]
const NODE_CANDIDATES: &[&str] = &["/usr/local/bin/node", "/usr/bin/node"];

/// What happened when we tried to bring the server up. Held in Tauri state so
/// the tray can report it instead of the popover silently rendering a blank
/// webview — a status dashboard that cannot report its own status was one of the
/// original complaints.
pub enum ServerState {
    /// We spawned it and own its lifetime; kill it on exit.
    Spawned(Child),
    /// Something was already listening (e.g. `npm run dev`); leave it alone.
    Attached,
    Failed(String),
}

pub struct Sidecar(pub Mutex<ServerState>);

impl Sidecar {
    pub fn status_line(&self) -> String {
        match &*self.0.lock().unwrap() {
            ServerState::Spawned(_) => format!("Server running on :{SERVER_PORT}"),
            ServerState::Attached => {
                format!("Attached to a server already on :{SERVER_PORT}")
            }
            ServerState::Failed(why) => format!("Server not running — {why}"),
        }
    }

    pub fn is_healthy(&self) -> bool {
        !matches!(&*self.0.lock().unwrap(), ServerState::Failed(_))
    }

    /// Only ever kills a process we started ourselves.
    pub fn shutdown(&self) {
        let mut guard = self.0.lock().unwrap();
        if let ServerState::Spawned(child) = &mut *guard {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// True if something is accepting connections on the server port.
pub fn server_is_up() -> bool {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, SERVER_PORT));
    TcpStream::connect_timeout(&addr, PROBE_TIMEOUT).is_ok()
}

fn find_node() -> Option<PathBuf> {
    for candidate in NODE_CANDIDATES {
        let path = Path::new(candidate);
        if path.is_file() {
            return Some(path.to_path_buf());
        }
    }
    // Last resort: a PATH lookup, which only helps when launched from a shell.
    let path_var = std::env::var_os("PATH")?;
    std::env::split_paths(&path_var)
        .map(|dir| dir.join("node"))
        .find(|candidate| candidate.is_file())
}

/// Resolves a bundled resource, tolerating the layout difference between a
/// packaged `.app` and `tauri dev`.
fn resource(app: &AppHandle, relative: &str) -> Option<PathBuf> {
    let dir = app.path().resource_dir().ok()?;
    let direct = dir.join(relative);
    if direct.exists() {
        return Some(direct);
    }
    // `tauri dev` resolves resources relative to the crate, so `../` entries in
    // tauri.conf.json land under an `_up_` prefix.
    let up = dir.join("_up_").join(relative);
    if up.exists() {
        return Some(up);
    }
    None
}

/// Bring the server up, or explain why we could not.
///
/// Probe-then-attach: if a server is already listening we attach rather than
/// spawning a second one, so running `npm run dev` alongside the installed app
/// does not fight over the port.
pub fn start(app: &AppHandle) -> ServerState {
    if server_is_up() {
        log::info!("sidecar: server already listening on :{SERVER_PORT}, attaching");
        return ServerState::Attached;
    }

    let Some(node) = find_node() else {
        let why = format!(
            "no Node.js interpreter found (looked in {} and PATH)",
            NODE_CANDIDATES.join(", ")
        );
        log::error!("sidecar: {why}");
        return ServerState::Failed(why);
    };

    let Some(bundle) = resource(app, "dist/server-bundle.mjs") else {
        let why = "server bundle missing from app resources".to_string();
        log::error!("sidecar: {why}");
        return ServerState::Failed(why);
    };

    let mut cmd = Command::new(&node);
    cmd.arg(&bundle)
        .env("NODE_ENV", "production")
        .env("PORT", SERVER_PORT.to_string())
        .env("CENTRAL_BRAIN_WATCH_PARENT", "1")
        // A pipe we never write to: while this process lives the pipe stays open, and
        // when it dies for ANY reason (quit, SIGTERM, SIGKILL, crash) the OS closes the
        // write end and the server sees EOF and exits. Measured: without this, SIGTERM
        // to the app left an orphan still holding the port, which the next launch would
        // then attach to. Do not drop `child.stdin` — that closes the pipe immediately.
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    // A bundled single file cannot infer these; the server reads them from env.
    // CENTRAL_BRAIN_DATA_DIR is deliberately NOT set, so the app and
    // `npm run dev` share the server's own platform user-data directory.
    if let Some(client) = resource(app, "dist/client") {
        cmd.env("CENTRAL_BRAIN_CLIENT_DIR", client);
    }
    if let Some(hooks) = resource(app, "hooks") {
        cmd.env("CENTRAL_BRAIN_HOOKS_DIR", hooks);
    }

    let child = match cmd.spawn() {
        Ok(child) => child,
        Err(err) => {
            let why = format!("could not launch {}: {err}", node.display());
            log::error!("sidecar: {why}");
            return ServerState::Failed(why);
        }
    };

    log::info!(
        "sidecar: spawned {} {} (pid {})",
        node.display(),
        bundle.display(),
        child.id()
    );

    let deadline = Instant::now() + STARTUP_TIMEOUT;
    while Instant::now() < deadline {
        if server_is_up() {
            return ServerState::Spawned(child);
        }
        std::thread::sleep(Duration::from_millis(200));
    }

    let mut child = child;
    let _ = child.kill();
    let _ = child.wait();
    let why = format!("server did not start listening within {STARTUP_TIMEOUT:?}");
    log::error!("sidecar: {why}");
    ServerState::Failed(why)
}

#[cfg(test)]
#[path = "sidecar_tests.rs"]
mod tests;
