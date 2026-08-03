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
fn newest_version_dir_picks_the_highest_version() {
    // nvm-style layout: one directory per installed version. "9" would beat
    // "22" under the lexicographic comparison this replaces.
    let base = std::env::temp_dir().join(format!("cb-sidecar-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    for v in ["v9.9.9", "v20.11.1", "v22.5.1", "not-a-version"] {
        std::fs::create_dir_all(base.join(v)).unwrap();
    }
    let newest = newest_version_dir(&base).expect("expected a version directory");
    assert!(newest.ends_with("v22.5.1"), "picked {newest:?}");
    let _ = std::fs::remove_dir_all(&base);

    assert!(newest_version_dir(Path::new("/definitely/not/a/real/dir")).is_none());
}

#[test]
fn server_probe_is_false_when_nothing_listens_and_true_when_something_does() {
    // Bind the real port so the probe has something to find. If the port is
    // already in use (a dev server is running), skip rather than fail — this
    // test is about the probe, not about the developer's environment.
    match TcpListener::bind(("127.0.0.1", server_port())) {
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

#[test]
fn version_parsing_and_floor() {
    // Parse shapes node actually prints, plus junk.
    assert_eq!(parse_node_version("v22.12.0\n"), Some(vec![22, 12, 0]));
    assert_eq!(parse_node_version("23.1.0"), Some(vec![23, 1, 0]));
    assert_eq!(parse_node_version("not-a-version"), None);
    assert_eq!(parse_node_version(""), None);

    // The floor is 22.12: 22.11 fossil out, 22.12 in, any 23+ in.
    assert!(!version_meets_floor(&[22, 11, 9]));
    assert!(version_meets_floor(&[22, 12, 0]));
    assert!(version_meets_floor(&[23, 0, 0]));
    assert!(!version_meets_floor(&[20, 19, 0])); // fine for vite, not for the node22 bundle
}

#[test]
fn found_node_is_actually_new_enough() {
    // find_node must never hand back a binary below the floor — the exact
    // failure the review flagged: picking a fossil /usr/local/bin/node while
    // a valid newer install exists elsewhere.
    if let Some(found) = find_node() {
        let version = node_version(&found).expect("found node must answer --version");
        assert!(
            version_meets_floor(&version),
            "find_node returned {found:?} at {version:?}, below the {MIN_NODE:?} floor"
        );
    }
}
