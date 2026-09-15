use anyhow::{Context, Result, bail};
use std::path::PathBuf;
use oden_core::{
    config::RuntimeConfig,
    runtime::Runtime,
    test_runner::{TestOptions, TestStatus},
};

pub async fn run(mut args: impl Iterator<Item = String>) -> Result<i32> {
    let path = PathBuf::from(args.next().context("missing test component path")?);
    let mut config = RuntimeConfig::default();
    let mut options = TestOptions::default();
    let mut json = false;
    let mut timeout = None;
    while let Some(flag) = args.next() {
        match flag.as_str() {
            "--config" => {
                config = serde_json::from_slice(&std::fs::read(
                    args.next().context("missing config path")?,
                )?)?
            }
            "--timeout-ms" => timeout = Some(args.next().context("missing timeout")?.parse()?),
            "--filter" => options.filter = Some(args.next().context("missing test filter")?),
            "--list" => options.list = true,
            "--json" => json = true,
            _ => bail!("unknown test option {flag}"),
        }
    }
    if let Some(timeout) = timeout {
        config.timeout_ms = timeout;
    }
    let runtime = Runtime::new(config)?;
    let result = runtime.test(&path, &options).await;
    runtime.telemetry.flush().await;
    let report = result?;
    if json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        for test in &report.tests {
            let label = match test.status {
                TestStatus::Listed => "LIST",
                TestStatus::Passed => "PASS",
                TestStatus::Failed => "FAIL",
            };
            println!("{label} {} ({:.2} ms)", test.name, test.duration_ms);
            if let Some(error) = &test.error {
                println!("  {error}");
            }
        }
        if options.list {
            println!(
                "{} tests listed; {} invalid",
                report.tests.len(),
                report.failed
            );
        } else {
            println!("{} passed; {} failed", report.passed, report.failed);
        }
    }
    if report.tests.is_empty() {
        eprintln!("no tests matched");
    }
    Ok(if report.success() { 0 } else { 1 })
}
