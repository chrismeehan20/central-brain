use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

pub const DEFAULT_PORT: u16 = 4317;

/// The port the server, the probe, and the popover all use. `CENTRAL_BRAIN_PORT`
/// overrides the default — 4317 is also the OTLP gRPC default, so collisions are
/// plausible on a dev machine. Read once: probe, spawn, and window URL must
/// agree for the app's whole lifetime. Note a Finder-launched `.app` only sees
/// this via `launchctl setenv`; from a shell, a plain env var works.
pub fn server_port() -> u16 {
    static PORT: OnceLock<u16> = OnceLock::new();
    *PORT.get_or_init(|| {
        std::env::var("CENTRAL_BRAIN_PORT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(DEFAULT_PORT)
    })
}

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

/// Version-manager layouts probed after the static candidates, as
/// ($HOME-relative directory of per-version installs, path from a version
/// directory to the node binary). nvm, fnm, asdf, and mise all install this
/// way, entirely under $HOME where the static list can't see them — and they
/// only reach PATH through shell init, which a Finder-launched `.app` never
/// runs. The newest installed version wins; "the version some project's .nvmrc
/// prefers" is unknowable from out here, and any modern node runs the server.
const VERSION_MANAGER_LAYOUTS: &[(&str, &str)] = &[
    (".nvm/versions/node", "bin/node"),
    (".asdf/installs/nodejs", "bin/node"),
    (".local/share/mise/installs/node", "bin/node"),
    ("Library/Application Support/fnm/node-versions", "installation/bin/node"),
    (".local/share/fnm/node-versions", "installation/bin/node"),
];

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
            ServerState::Spawned(_) => format!("Server running on :{}", server_port()),
            ServerState::Attached => {
                format!("Attached to a server already on :{}", server_port())
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
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, server_port()));
    TcpStream::connect_timeout(&addr, PROBE_TIMEOUT).is_ok()
}

/// Picks the newest-versioned subdirectory of `dir` ("v22.5.1" and "22.5.1"
/// both parse; non-numeric components count as 0). Newest because the only
/// requirement is "a node recent enough to run the bundle", and the newest
/// install is the best guess at what the user considers current.
fn newest_version_dir(dir: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut best: Option<(Vec<u64>, PathBuf)> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let key: Vec<u64> = name
            .to_string_lossy()
            .trim_start_matches('v')
            .split('.')
            .map(|part| {
                part.chars()
                    .take_while(char::is_ascii_digit)
                    .collect::<String>()
                    .parse()
                    .unwrap_or(0)
            })
            .collect();
        if best.as_ref().map_or(true, |(k, _)| key > *k) {
            best = Some((key, path));
        }
    }
    best.map(|(_, path)| path)
}

/// The floor the server bundle actually needs: esbuild targets node22 and
/// `package.json` declares `>=22.12` (Vite 8's 22.x minimum). Must match both.
const MIN_NODE: (u64, u64) = (22, 12);

/// "v22.12.0\n" → [22, 12, 0]. Tolerates a missing "v" and junk suffixes.
fn parse_node_version(output: &str) -> Option<Vec<u64>> {
    let trimmed = output.trim().trim_start_matches('v');
    if trimmed.is_empty() {
        return None;
    }
    let key: Vec<u64> = trimmed
        .split('.')
        .map(|part| {
            part.chars()
                .take_while(char::is_ascii_digit)
                .collect::<String>()
                .parse()
                .unwrap_or(0)
        })
        .collect();
    if key.first().copied().unwrap_or(0) == 0 {
        return None; // "not-a-version" parses to [0]; never a real node
    }
    Some(key)
}

fn version_meets_floor(version: &[u64]) -> bool {
    let major = version.first().copied().unwrap_or(0);
    let minor = version.get(1).copied().unwrap_or(0);
    major > MIN_NODE.0 || (major == MIN_NODE.0 && minor >= MIN_NODE.1)
}

/// Ask a candidate binary what it is. A ~30ms subprocess per candidate, once
/// at startup — cheap insurance against picking a fossil `/usr/local/bin/node`
/// while a perfectly good newer install sits one probe further down the list.
fn node_version(path: &Path) -> Option<Vec<u64>> {
    let output = Command::new(path).arg("--version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    parse_node_version(&String::from_utf8_lossy(&output.stdout))
}

/// Every place a node interpreter might live, in preference order.
fn candidate_nodes() -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> =
        NODE_CANDIDATES.iter().map(PathBuf::from).collect();

    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        // Volta keeps a stable shim rather than per-version directories.
        candidates.push(home.join(".volta/bin/node"));
        for (versions_dir, node_rel) in VERSION_MANAGER_LAYOUTS {
            if let Some(version) = newest_version_dir(&home.join(versions_dir)) {
                candidates.push(version.join(node_rel));
            }
        }
    }

    // Last resort: a PATH lookup, which only helps when launched from a shell.
    if let Some(path_var) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path_var).map(|dir| dir.join("node")));
    }
    candidates
}

fn find_node() -> Option<PathBuf> {
    // Explicit override first — the escape hatch for any layout not probed
    // below. Honored even when old or unidentifiable (it IS the escape hatch),
    // but loudly, so a hung startup has a log line pointing at the cause.
    if let Some(explicit) = std::env::var_os("CENTRAL_BRAIN_NODE") {
        let path = PathBuf::from(explicit);
        if path.is_file() {
            match node_version(&path) {
                Some(v) if version_meets_floor(&v) => {}
                got => log::warn!(
                    "sidecar: CENTRAL_BRAIN_NODE is {} (reported {:?}), below the required {}.{} — using it anyway because it is explicit",
                    path.display(),
                    got,
                    MIN_NODE.0,
                    MIN_NODE.1
                ),
            }
            return Some(path);
        }
        log::warn!(
            "sidecar: CENTRAL_BRAIN_NODE is set but is not a file, ignoring: {}",
            path.display()
        );
    }

    // First candidate that exists AND is new enough. Existing-but-old (the
    // fossil /usr/local/bin/node problem) is skipped with a log line instead
    // of being spawned and failing on modern syntax somewhere mid-bundle.
    for candidate in candidate_nodes() {
        if !candidate.is_file() {
            continue;
        }
        match node_version(&candidate) {
            Some(version) if version_meets_floor(&version) => return Some(candidate),
            Some(version) => log::warn!(
                "sidecar: skipping {} — node {} is older than the required {}.{}",
                candidate.display(),
                version.iter().map(u64::to_string).collect::<Vec<_>>().join("."),
                MIN_NODE.0,
                MIN_NODE.1
            ),
            None => log::warn!(
                "sidecar: skipping {} — `--version` failed or was unparseable",
                candidate.display()
            ),
        }
    }
    None
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
        log::info!("sidecar: server already listening on :{}, attaching", server_port());
        return ServerState::Attached;
    }

    let Some(node) = find_node() else {
        let why = format!(
            "no Node.js >= {}.{} found (looked in {}, nvm/volta/fnm/asdf/mise installs, \
             and PATH; older installs were skipped — see the log. Set CENTRAL_BRAIN_NODE \
             to a node binary to override)",
            MIN_NODE.0,
            MIN_NODE.1,
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
        .env("PORT", server_port().to_string())
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
