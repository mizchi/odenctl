//! Compile and validate one immutable component snapshot without running guest code.
use crate::{
    runtime::Runtime,
    server::HttpServer,
    service::{ResidentService, ServiceOptions},
};
use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path, sync::Arc};
use wasmtime::{
    component::{Component, types::ComponentItem},
    error::Context as _,
};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Command,
    Http,
    Service,
}

#[derive(Clone, Serialize)]
pub struct Interface {
    pub name: String,
    pub kind: &'static str,
    pub members: Vec<String>,
}
#[derive(Clone, Serialize)]
pub struct ComponentReport {
    pub schema_version: u32,
    pub sha256: String,
    pub imports: Vec<Interface>,
    pub exports: Vec<Interface>,
    pub compatible_modes: Vec<Mode>,
    pub mode_errors: BTreeMap<Mode, String>,
    pub link_errors: Vec<String>,
    /// Interfaces expose potential capabilities, not evidence that code uses them.
    pub capability_interfaces: Vec<String>,
}

pub struct CheckedComponent {
    runtime: Arc<Runtime>,
    component: Component,
    pub report: ComponentReport,
}
impl CheckedComponent {
    pub fn telemetry(&self) -> crate::telemetry::Telemetry {
        self.runtime.telemetry.clone()
    }
    pub fn load(runtime: Arc<Runtime>, path: &Path) -> Result<Self> {
        let bytes = std::fs::read(path).context("read component")?;
        let span = runtime
            .telemetry
            .start("component.compile", None, 1, "compile");
        let result = Component::new(&runtime.engine, &bytes).context("compile component");
        span.finish(if result.is_ok() { "ok" } else { "error" });
        let component = result?;
        let ty = component.component_type();
        let describe = |(name, item): (&str, ComponentItem)| {
            let (kind, members) = match item {
                ComponentItem::ComponentInstance(instance) => (
                    "interface",
                    instance
                        .exports(&runtime.engine)
                        .map(|(name, _)| name.to_owned())
                        .collect(),
                ),
                ComponentItem::ComponentFunc(_) => ("function", vec![]),
                ComponentItem::CoreFunc(_) => ("core-function", vec![]),
                ComponentItem::Module(_) => ("module", vec![]),
                ComponentItem::Component(_) => ("component", vec![]),
                ComponentItem::Type(_) => ("type", vec![]),
                ComponentItem::Resource(_) => ("resource", vec![]),
            };
            Interface {
                name: name.to_owned(),
                kind,
                members,
            }
        };
        let imports: Vec<_> = ty
            .imports(&runtime.engine)
            .map(|(name, item)| describe((name, item.ty)))
            .collect();
        let exports = ty
            .exports(&runtime.engine)
            .map(|(name, item)| describe((name, item.ty)))
            .collect();
        let capability_interfaces = imports
            .iter()
            .filter(|i| i.name.starts_with("wasi:") || i.name.starts_with("wasmplane:durable/"))
            .map(|i| i.name.clone())
            .collect();
        let mut report = ComponentReport {
            schema_version: 1,
            sha256: format!("{:x}", Sha256::digest(&bytes)),
            imports,
            exports,
            compatible_modes: vec![],
            mode_errors: BTreeMap::new(),
            link_errors: vec![],
            capability_interfaces,
        };
        match runtime.linker()?.instantiate_pre(&component) {
            Ok(pre) => {
                let command = wasmtime_wasi::p3::bindings::CommandPre::new(pre.clone())
                    .map(|_| ())
                    .or_else(|_| {
                        wasmtime_wasi::p2::bindings::CommandPre::new(pre.clone()).map(|_| ())
                    });
                let http = crate::server::prepare_http(&runtime, &component).map(|_| ());
                let service = crate::service::validate_pre(pre)
                    .and_then(|_| crate::server::prepare_http(&runtime, &component).map(|_| ()));
                for (mode, result) in [
                    (Mode::Command, command.map_err(anyhow::Error::from)),
                    (Mode::Http, http),
                    (Mode::Service, service),
                ] {
                    match result {
                        Ok(()) => report.compatible_modes.push(mode),
                        Err(error) => {
                            report.mode_errors.insert(mode, format!("{error:#}"));
                        }
                    }
                }
            }
            Err(error) => report.link_errors.push(format!("{error:#}")),
        }
        Ok(Self {
            runtime,
            component,
            report,
        })
    }
    pub fn validate(&self, mode: Mode) -> Result<()> {
        if !self.report.link_errors.is_empty() {
            bail!("{}", self.report.link_errors.join("; "));
        }
        if !self.report.compatible_modes.contains(&mode) {
            bail!(
                "component is not compatible with {} mode: {}",
                serde_json::to_value(mode)?.as_str().unwrap(),
                self.report
                    .mode_errors
                    .get(&mode)
                    .map(String::as_str)
                    .unwrap_or("missing entry point")
            );
        }
        // Verify host resources can be prepared; no guest code is instantiated.
        drop(self.runtime.store(&[])?);
        Ok(())
    }
    pub async fn command(&self, args: &[String]) -> Result<i32> {
        self.runtime.run_component(&self.component, args).await
    }
    pub fn http(&self) -> Result<Arc<HttpServer>> {
        HttpServer::from_component(self.runtime.clone(), &self.component)
    }
    pub async fn resident(&self, options: ServiceOptions) -> Result<ResidentService> {
        ResidentService::from_component(self.runtime.clone(), &self.component, options).await
    }
}
