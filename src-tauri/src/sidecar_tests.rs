//! Tests for the parts of the sidecar that do not need a running Tauri app.
//!
//! Note these are NOT covered by CI: `.github/workflows/ci.yml` deliberately
//! excludes the Rust build (it needs a macOS runner). Run them with
//! `cargo test --manifest-path src-tauri/Cargo.toml`.

use super::*;
use std::net::TcpListener;

#[test]
fn finds_a_node_interpreter_on_a_machine_that_has_one() {
    // The developer machine and any CI runner that could run this test has node.
    // The value of the assertion is that it must be an ABSOLUTE, existing path —
    // a bare "node" would satisfy a naive implementation and then fail only in
    // the packaged app, where PATH does not include Homebrew or /usr/local.
    let found = find_node().expect("expected to find a node interpreter");
    assert!(found.is_absolute(), "interpreter path must be absolute: {found:?}");
    assert!(found.is_file(), "interpreter must exist: {found:?}");
}

#[test]
fn candidate_list_is_absolute_paths_only() {
    // A relative entry here would reintroduce the PATH-dependence this list
    // exists to avoid.
    for candidate in NODE_CANDIDATES {
        assert!(
            Path::new(candidate).is_absolute(),
            "candidate {candidate} must be absolute"
        );
    }
}

#[test]
fn server_probe_is_false_when_nothing_listens_and_true_when_something_does() {
    // Bind the real port so the probe has something to find. If the port is
    // already in use (a dev server is running), skip rather than fail — this
    // test is about the probe, not about the developer's environment.
    match TcpListener::bind(("127.0.0.1", SERVER_PORT)) {
        Ok(listener) => {
            assert!(server_is_up(), "probe should see our listener");
            drop(listener);
            // After dropping, the port should be free again.
            assert!(!server_is_up(), "probe should not see a closed listener");
        }
        Err(_) => {
            // Something is already on the port, so the probe must say so.
            assert!(
                server_is_up(),
                "port was occupied, so the probe must report the server as up"
            );
        }
    }
}
