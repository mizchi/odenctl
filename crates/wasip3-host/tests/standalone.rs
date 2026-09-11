use std::process::Command;

#[test]
fn command_runs_without_a_control_plane_and_propagates_failure() {
    let dir = tempfile::tempdir().unwrap();
    for (result, success) in [(0, true), (1, false)] {
        let component = dir.path().join(format!("command-{result}.wat"));
        std::fs::write(
            &component,
            format!(
                r#"(component
          (core module $m (func (export "run") (result i32) i32.const {result}))
          (core instance $i (instantiate $m))
          (func $run (result (result)) (canon lift (core func $i "run")))
          (instance $cli (export "run" (func $run)))
          (export "wasi:cli/run@0.2.0" (instance $cli)))"#
            ),
        )
        .unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_wasmplane"))
            .current_dir(dir.path())
            .args(["run", component.to_str().unwrap()])
            .output()
            .unwrap();
        assert_eq!(
            output.status.success(),
            success,
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    assert!(!dir.path().join("wasmplane.sqlite").exists());
}

#[test]
fn cpu_bound_command_is_interrupted() {
    let dir = tempfile::tempdir().unwrap();
    let component = dir.path().join("loop.wat");
    std::fs::write(
        &component,
        r#"(component
      (core module $m (func (export "run") (result i32) (loop $l br $l) i32.const 0))
      (core instance $i (instantiate $m))
      (func $run (result (result)) (canon lift (core func $i "run")))
      (instance $cli (export "run" (func $run)))
      (export "wasi:cli/run@0.2.0" (instance $cli)))"#,
    )
    .unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_wasmplane"))
        .args(["run", component.to_str().unwrap(), "--timeout-ms", "50"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("deadline"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
