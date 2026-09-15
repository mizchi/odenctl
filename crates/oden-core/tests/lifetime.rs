use std::time::{Duration, Instant};
use oden_core::{config::RuntimeConfig, runtime::Runtime};

#[tokio::test(flavor = "current_thread")]
async fn cpu_bound_guest_yields_so_its_owner_can_cancel_it() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("loop.wat");
    std::fs::write(
        &path,
        r#"(component
      (core module $m (func (export "run") (result i32) (loop $l br $l) i32.const 0))
      (core instance $i (instantiate $m))
      (func $run (result (result)) (canon lift (core func $i "run")))
      (instance $cli (export "run" (func $run)))
      (export "wasi:cli/run@0.2.0" (instance $cli)))"#,
    )
    .unwrap();
    let runtime = Runtime::new(RuntimeConfig {
        timeout_ms: 2000,
        ..Default::default()
    })
    .unwrap();
    let started = Instant::now();
    let result = tokio::time::timeout(Duration::from_millis(50), runtime.run(&path, &[])).await;
    assert!(
        result.is_err(),
        "the caller's cancellation must win over the guest deadline"
    );
    assert!(started.elapsed() < Duration::from_millis(1000));
    drop(runtime);
}
