//! Language-neutral tests discovered from the component's public WIT exports.
use crate::runtime::{Host, Runtime};
use anyhow::{Result, bail};
use serde::Serialize;
use std::{path::Path, time::Instant};
use wasmtime::component::{
    Component, ComponentExportIndex, InstancePre, Val,
    types::{ComponentFunc, ComponentItem, Type},
};
use wasmtime::error::Context as _;

#[derive(Default)]
pub struct TestOptions {
    /// Case-sensitive substring of the fully qualified export path.
    pub filter: Option<String>,
    /// Discover and type-check exports without instantiating guest code.
    pub list: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TestStatus {
    Listed,
    Passed,
    Failed,
}

#[derive(Serialize)]
pub struct TestResult {
    pub name: String,
    pub asynchronous: bool,
    pub status: TestStatus,
    pub duration_ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize)]
pub struct TestReport {
    pub schema_version: u32,
    pub tests: Vec<TestResult>,
    pub passed: usize,
    pub failed: usize,
}

impl TestReport {
    pub fn success(&self) -> bool {
        !self.tests.is_empty() && self.failed == 0
    }
}

struct TestExport {
    name: String,
    index: ComponentExportIndex,
    ty: ComponentFunc,
}

fn valid_signature(ty: &ComponentFunc) -> bool {
    if ty.params().len() != 0 {
        return false;
    }
    let results: Vec<_> = ty.results().collect();
    match results.as_slice() {
        [] => true,
        [Type::Result(result)] => {
            result.ok().is_none() && matches!(result.err(), None | Some(Type::String))
        }
        _ => false,
    }
}

fn discover(runtime: &Runtime, component: &Component) -> Vec<TestExport> {
    let mut pending: Vec<_> = component
        .component_type()
        .exports(&runtime.engine)
        .map(|(name, item)| {
            (
                name.to_owned(),
                component.get_export_index(None, name).unwrap(),
                item.ty,
            )
        })
        .collect();
    let mut tests = Vec::new();
    while let Some((path, index, item)) = pending.pop() {
        match item {
            ComponentItem::ComponentFunc(ty)
                if path.rsplit('/').next().unwrap().ends_with("-test") =>
            {
                tests.push(TestExport {
                    name: path,
                    index,
                    ty,
                });
            }
            ComponentItem::ComponentInstance(instance) => {
                for (name, item) in instance.exports(&runtime.engine) {
                    let child = component.get_export_index(Some(&index), name).unwrap();
                    pending.push((format!("{path}/{name}"), child, item.ty));
                }
            }
            _ => (),
        }
    }
    tests.sort_by(|a, b| a.name.cmp(&b.name));
    tests
}

impl TestExport {
    async fn invoke(&self, runtime: &Runtime, pre: &InstancePre<Host>, path: &Path) -> Result<()> {
        let span = runtime.telemetry.start("test.run", None, 1, "test");
        span.attribute("test.name", serde_json::json!(self.name));
        let result = runtime
            .deadline(async {
                // Keep the report on stdout parseable; guest stderr is inherited.
                // Dropping this Store also cancels any unfinished guest tasks.
                let mut store = runtime.store_with_config(
                    &[path.to_string_lossy().into_owned()],
                    &runtime.config,
                    None,
                    false,
                )?;
                let instance = pre.instantiate_async(&mut store).await?;
                let func = instance
                    .get_func(&mut store, &self.index)
                    .context("missing test export")?;
                let mut values = vec![Val::Bool(false); self.ty.results().len()];
                // Drives synchronous exports, P3 async exports and their host I/O.
                // Wasmtime 48 also handles canonical post-return here.
                func.call_async(&mut store, &[], &mut values).await?;
                match values.as_slice() {
                    [] | [Val::Result(Ok(None))] => Ok(()),
                    [Val::Result(Err(Some(value)))] => match value.as_ref() {
                        Val::String(message) => bail!("{message}"),
                        _ => bail!("unexpected test error payload"),
                    },
                    [Val::Result(Err(None))] => bail!("test returned err"),
                    _ => bail!("unexpected test result"),
                }
            })
            .await;
        span.finish(if result.is_ok() { "ok" } else { "error" });
        result
    }
}

impl Runtime {
    /// Compile once, then run each selected test sequentially in a fresh Store.
    /// No service lifecycle hooks or command entry points are invoked.
    pub async fn test(&self, path: &Path, options: &TestOptions) -> Result<TestReport> {
        let component = Component::from_file(&self.engine, path).context("load test component")?;
        let tests: Vec<_> = discover(self, &component)
            .into_iter()
            .filter(|test| {
                options
                    .filter
                    .as_ref()
                    .is_none_or(|filter| test.name.contains(filter))
            })
            .collect();
        // Listing must not resolve host resources or run a component's core start.
        let pre = if options.list || tests.is_empty() {
            None
        } else {
            Some(
                self.linker()?
                    .instantiate_pre(&component)
                    .context("link test component")?,
            )
        };
        let mut report = TestReport {
            schema_version: 1,
            tests: Vec::new(),
            passed: 0,
            failed: 0,
        };
        for test in tests {
            let started = Instant::now();
            let outcome = if !valid_signature(&test.ty) {
                Err(anyhow::anyhow!(
                    "unsupported test signature: expected func(), func() -> result, or func() -> result<_, string> (sync or async)"
                ))
            } else if options.list {
                Ok(())
            } else {
                test.invoke(self, pre.as_ref().unwrap(), path).await
            };
            let status = match &outcome {
                Err(_) => {
                    report.failed += 1;
                    TestStatus::Failed
                }
                Ok(()) if options.list => TestStatus::Listed,
                Ok(()) => {
                    report.passed += 1;
                    TestStatus::Passed
                }
            };
            report.tests.push(TestResult {
                name: test.name,
                asynchronous: test.ty.async_(),
                status,
                duration_ms: started.elapsed().as_secs_f64() * 1000.0,
                error: outcome.err().map(|error| format!("{error:#}")),
            });
        }
        Ok(report)
    }
}
