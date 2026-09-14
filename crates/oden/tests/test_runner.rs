use serde_json::Value;
use std::process::{Command, Output};

fn invoke(wat: &str, args: &[&str]) -> Output {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("tests.wat");
    std::fs::write(&path, wat).unwrap();
    Command::new(env!("CARGO_BIN_EXE_oden"))
        .args(["test", path.to_str().unwrap()])
        .args(args)
        .env("OTEL_SDK_DISABLED", "true")
        .output()
        .unwrap()
}

fn report(output: &Output) -> Value {
    serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
        panic!(
            "{error}: stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    })
}

const MIXED: &str = r#"(component
  (core module $m
    (memory (export "memory") 1)
    (global $state (mut i32) (i32.const 0))
    (func (export "isolated")
      global.get $state if unreachable end
      i32.const 1 global.set $state)
    (func (export "ok") (result i32) i32.const 0)
    (func (export "err") (result i32) i32.const 1)
    (func (export "message") (result i32)
      i32.const 16 i32.const 1 i32.store
      i32.const 20 i32.const 64 i32.store
      i32.const 24 i32.const 6 i32.store
      i32.const 16)
    (data (i32.const 64) "\e5\a4\b1\e6\95\97")
    (func (export "trap") unreachable)
    (func (export "loop") (loop $again br $again))
    (func (export "parameter") (param i32)))
  (core instance $i (instantiate $m))
  (func $isolated (canon lift (core func $i "isolated")))
  (func $ok (result (result)) (canon lift (core func $i "ok")))
  (func $err (result (result)) (canon lift (core func $i "err")))
  (func $message (result (result (error string)))
    (canon lift (core func $i "message") (memory (core memory $i "memory"))))
  (func $trap (canon lift (core func $i "trap")))
  (func $loop (canon lift (core func $i "loop")))
  (func $bad (param "input" u32) (canon lift (core func $i "parameter")))
  (export "a-isolation-test" (func $isolated))
  (export "b-isolation-test" (func $isolated))
  (export "c-error-test" (func $err))
  (export "d-message-test" (func $message))
  (export "e-trap-test" (func $trap))
  (export "f-timeout-test" (func $loop))
  (export "g-invalid-test" (func $bad))
  (instance $suite (export "ok-test" (func $ok)))
  (instance $outer (export "inner" (instance $suite)))
  (export "suite" (instance $outer))
  (export "z-after-test" (func $ok))
  (export "helper" (func $trap)))"#;

#[test]
fn discovers_exports_isolates_state_and_continues_after_failures() {
    let output = invoke(MIXED, &["--json", "--timeout-ms", "50"]);
    assert_eq!(output.status.code(), Some(1));
    let report = report(&output);
    assert_eq!(report["schema_version"], 1);
    assert_eq!(report["passed"], 4);
    assert_eq!(report["failed"], 5);
    let tests = report["tests"].as_array().unwrap();
    assert_eq!(tests.len(), 9);
    assert_eq!(tests[0]["name"], "a-isolation-test");
    assert_eq!(tests[1]["status"], "passed");
    assert!(tests[2]["error"].as_str().unwrap().contains("err"));
    assert_eq!(tests[3]["error"], "失敗");
    assert!(tests[4]["error"].as_str().unwrap().contains("unreachable"));
    assert!(tests[5]["error"].as_str().unwrap().contains("deadline"));
    assert!(tests[6]["error"].as_str().unwrap().contains("signature"));
    assert_eq!(tests[7]["name"], "suite/inner/ok-test");
    assert_eq!(tests[8]["status"], "passed");
}

#[test]
fn filter_and_human_output_are_useful_in_ci() {
    let output = invoke(MIXED, &["--filter", "isolation"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(text.contains("PASS a-isolation-test"));
    assert!(text.contains("2 passed; 0 failed"));
    assert!(!text.contains("c-error-test"));
}

#[test]
fn listing_does_not_instantiate_or_invoke_guest_code() {
    let output = invoke(
        r#"(component
      (core module $m
        (func $start unreachable) (start $start)
        (func (export "test") unreachable))
      (core instance $i (instantiate $m))
      (func $f (canon lift (core func $i "test")))
      (export "never-test" (func $f)))"#,
        &["--list", "--json"],
    );
    assert!(output.status.success());
    let report = report(&output);
    assert_eq!(report["tests"][0]["name"], "never-test");
    assert_eq!(report["tests"][0]["status"], "listed");
    assert_eq!(report["passed"], 0);
}

#[test]
fn zero_matches_fail_instead_of_silently_passing() {
    for (wat, args) in [
        ("(component)", vec!["--json"]),
        (MIXED, vec!["--json", "--filter", "absent"]),
    ] {
        let output = invoke(wat, &args);
        assert_eq!(output.status.code(), Some(1));
        assert_eq!(report(&output)["tests"], serde_json::json!([]));
        assert!(String::from_utf8_lossy(&output.stderr).contains("no tests matched"));
    }
}

#[test]
fn rejects_arbitrary_return_values_and_bad_cli_options() {
    let wat = r#"(component
      (core module $m (func (export "f") (result i32) i32.const 0))
      (core instance $i (instantiate $m))
      (func $f (result u32) (canon lift (core func $i "f")))
      (export "number-test" (func $f)))"#;
    let output = invoke(wat, &["--json"]);
    assert_eq!(report(&output)["failed"], 1);
    assert!(
        report(&output)["tests"][0]["error"]
            .as_str()
            .unwrap()
            .contains("signature")
    );
    for args in [&["--filter"][..], &["--resident"], &["--timeout-ms", "0"]] {
        let output = invoke(wat, args);
        assert_eq!(output.status.code(), Some(1));
        assert!(!output.stderr.is_empty());
    }
}

#[test]
fn instantiation_deadline_is_per_test() {
    let wat = r#"(component
      (core module $m
        (func $start (loop $again br $again)) (start $start)
        (func (export "f")))
      (core instance $i (instantiate $m))
      (func $f (canon lift (core func $i "f")))
      (export "first-test" (func $f))
      (export "second-test" (func $f)))"#;
    let output = invoke(wat, &["--json", "--timeout-ms", "30"]);
    let report = report(&output);
    assert_eq!(report["failed"], 2);
    for test in report["tests"].as_array().unwrap() {
        assert!(test["error"].as_str().unwrap().contains("deadline"));
    }
}

#[test]
fn wasi_exit_zero_does_not_pass_a_test_that_did_not_return() {
    let wat = r#"(component
      (import "wasi:cli/exit@0.2.0" (instance $cli
        (export "exit" (func (param "status" (result))))))
      (alias export $cli "exit" (func $exit))
      (core func $exit (canon lower (func $exit)))
      (core module $m
        (import "host" "exit" (func $exit (param i32)))
        (func (export "f") i32.const 0 call $exit))
      (core instance $host (export "exit" (func $exit)))
      (core instance $i (instantiate $m (with "host" (instance $host))))
      (func $f (canon lift (core func $i "f")))
      (export "exit-test" (func $f)))"#;
    let output = invoke(wat, &["--json"]);
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(report(&output)["failed"], 1);
    assert!(
        report(&output)["tests"][0]["error"]
            .as_str()
            .unwrap()
            .contains("exit")
    );
}

#[test]
fn list_reports_invalid_signatures_without_running_them() {
    let output = invoke(MIXED, &["--list", "--json"]);
    assert_eq!(output.status.code(), Some(1));
    let report = report(&output);
    assert_eq!(report["tests"].as_array().unwrap().len(), 9);
    assert_eq!(report["failed"], 1);
    assert_eq!(report["passed"], 0);
    assert_eq!(report["tests"][6]["status"], "failed");
    assert_eq!(report["tests"][5]["status"], "listed");
}
