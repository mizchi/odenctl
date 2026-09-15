//! Local application contract and development supervisor. Build commands are
//! argument vectors, never shell programs. Every path is relative to the manifest.
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::{net::TcpListener, process::Command, task::JoinHandle};
use tokio_util::sync::CancellationToken;
use oden_core::{
    component::{CheckedComponent, ComponentReport, Mode},
    config::RuntimeConfig,
    runtime::Runtime,
    service::ServiceOptions,
};

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    version: u32,
    component: PathBuf,
    mode: Mode,
    #[serde(default = "default_listen")]
    listen: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    runtime: RuntimeConfig,
    #[serde(default)]
    service: ServiceOptions,
    #[serde(default)]
    build: Vec<Vec<String>>,
    #[serde(default)]
    watch: Vec<PathBuf>,
}
fn default_listen() -> String {
    "127.0.0.1:8080".into()
}

#[derive(Clone)]
pub struct App {
    manifest: PathBuf,
    directory: PathBuf,
    spec: Manifest,
}

pub struct PreparedApp {
    app: App,
    component: CheckedComponent,
}

#[derive(Default, Serialize)]
pub struct Grants {
    env: Vec<String>,
    directories: Vec<DirectoryInfo>,
    outbound_origins: Vec<String>,
    durable: Vec<String>,
}
#[derive(Serialize)]
struct DirectoryInfo {
    host: PathBuf,
    guest: String,
    write: bool,
}
#[derive(Serialize)]
pub struct CheckReport {
    schema_version: u32,
    pub valid: bool,
    pub component: Option<ComponentReport>,
    pub grants: Grants,
    pub errors: Vec<String>,
}

pub fn check(path: &Path) -> CheckReport {
    let mut report = CheckReport {
        schema_version: 1,
        valid: false,
        component: None,
        grants: Grants::default(),
        errors: vec![],
    };
    let run = || -> Result<(ComponentReport, Option<String>, Grants)> {
        let app = App::load(path)?;
        let grants = Grants {
            env: app.spec.runtime.env.keys().cloned().collect(),
            directories: app
                .spec
                .runtime
                .directories
                .iter()
                .map(|d| DirectoryInfo {
                    host: d.host.clone(),
                    guest: d.guest.clone(),
                    write: d.write,
                })
                .collect(),
            outbound_origins: app.spec.runtime.outbound_origins.clone(),
            durable: app.spec.runtime.durable.keys().cloned().collect(),
        };
        let component =
            CheckedComponent::load(Runtime::new(app.spec.runtime)?, &app.spec.component)?;
        let error = component
            .validate(app.spec.mode)
            .err()
            .map(|e| format!("{e:#}"));
        Ok((component.report, error, grants))
    };
    match run() {
        Ok((component, error, grants)) => {
            report.component = Some(component);
            report.grants = grants;
            if let Some(error) = error {
                report.errors.push(error);
            } else {
                report.valid = true;
            }
        }
        Err(error) => report.errors.push(format!("{error:#}")),
    }
    report
}

impl App {
    pub fn load(path: &Path) -> Result<Self> {
        let manifest = path.canonicalize().context("find app manifest")?;
        let directory = manifest.parent().context("manifest directory")?.to_owned();
        let mut spec: Manifest =
            serde_json::from_slice(&std::fs::read(&manifest)?).context("parse app manifest")?;
        ensure!(
            spec.version == 1,
            "unsupported manifest version {}; expected 1",
            spec.version
        );
        ensure!(
            !spec.component.as_os_str().is_empty(),
            "component must not be empty"
        );
        spec.runtime.validate()?;
        spec.service.validate()?;
        ensure!(
            spec.build
                .iter()
                .all(|argv| !argv.is_empty() && !argv[0].is_empty()),
            "build commands must be nonempty argument arrays"
        );
        spec.component = directory.join(&spec.component);
        for grant in &mut spec.runtime.directories {
            grant.host = directory.join(&grant.host);
        }
        if spec.watch.is_empty() {
            spec.watch.push(spec.component.clone());
        }
        spec.watch = spec
            .watch
            .into_iter()
            .map(|path| directory.join(path))
            .collect();
        Ok(Self {
            manifest,
            directory,
            spec,
        })
    }

    pub async fn build(&self, cancel: &CancellationToken) -> Result<()> {
        for argv in &self.spec.build {
            ensure!(!cancel.is_cancelled(), "build cancelled");
            let mut command = Command::new(&argv[0]);
            command
                .args(&argv[1..])
                .current_dir(&self.directory)
                .kill_on_drop(true);
            // Put each build in its own process group so cancellation also
            // reaches compiler children of task runners such as just or cargo.
            #[cfg(unix)]
            command.process_group(0);
            let mut child = command
                .spawn()
                .with_context(|| format!("start build command {}", argv[0]))?;
            let status = tokio::select! {
                status = child.wait() => status?,
                _ = cancel.cancelled() => {
                    #[cfg(unix)]
                    if let Some(id) = child.id() {
                        // SAFETY: this unreaped child owns the process group we
                        // created above. Kill the whole group, including build
                        // descendants that ignore SIGTERM, before reaping it.
                        unsafe { libc::kill(-(id as i32), libc::SIGKILL); }
                    }
                    let _ = child.kill().await;
                    bail!("build cancelled");
                }
            };
            ensure!(
                status.success(),
                "build command {} exited with {status}",
                argv[0]
            );
        }
        ensure!(
            self.spec.component.is_file(),
            "component does not exist: {}",
            self.spec.component.display()
        );
        Ok(())
    }

    pub async fn run(self, cancel: CancellationToken) -> Result<i32> {
        self.prepare()?.run(cancel).await
    }

    pub fn prepare(&self) -> Result<PreparedApp> {
        let runtime = Runtime::new(self.spec.runtime.clone())?;
        let component = CheckedComponent::load(runtime, &self.spec.component)?;
        component.validate(self.spec.mode)?;
        Ok(PreparedApp {
            app: self.clone(),
            component,
        })
    }

    fn fingerprint(&self) -> Result<u64> {
        let mut hash = DefaultHasher::new();
        hash_path(&self.manifest, &mut hash)?;
        for path in &self.spec.watch {
            hash_path(path, &mut hash)?;
        }
        Ok(hash.finish())
    }
}

impl PreparedApp {
    async fn run(self, cancel: CancellationToken) -> Result<i32> {
        let telemetry = self.component.telemetry();
        let result = self.run_inner(cancel).await;
        telemetry.flush().await;
        result
    }
    async fn run_inner(self, cancel: CancellationToken) -> Result<i32> {
        let spec = self.app.spec;
        match spec.mode {
            Mode::Command => {
                let mut args = vec![spec.component.to_string_lossy().into_owned()];
                args.extend(spec.args);
                tokio::select! { result = self.component.command(&args) => result, _ = cancel.cancelled() => Ok(0) }
            }
            Mode::Http => {
                let server = self.component.http()?;
                let listener = TcpListener::bind(&spec.listen).await?;
                eprintln!("listening on http://{}", listener.local_addr()?);
                server.serve(listener, cancel.cancelled()).await?;
                Ok(0)
            }
            Mode::Service => {
                let listener = TcpListener::bind(&spec.listen).await?;
                let service = tokio::select! {
                    result = self.component.resident(spec.service) => result?,
                    _ = cancel.cancelled() => return Ok(0),
                };
                eprintln!("listening on http://{}", listener.local_addr()?);
                service.serve(listener, cancel.cancelled()).await?;
                Ok(0)
            }
        }
    }
}

fn hash_path(path: &Path, hash: &mut DefaultHasher) -> Result<()> {
    path.hash(hash);
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            "missing".hash(hash);
            return Ok(());
        }
        Err(error) => return Err(error.into()),
    };
    if metadata.is_symlink() {
        std::fs::read_link(path)?.hash(hash);
    } else if metadata.is_file() {
        std::fs::read(path)?.hash(hash);
    } else if metadata.is_dir() {
        let mut children = std::fs::read_dir(path)?
            .map(|entry| entry.map(|entry| entry.path()))
            .collect::<std::io::Result<Vec<_>>>()?;
        children.sort();
        for child in children {
            if matches!(
                child.file_name().and_then(|name| name.to_str()),
                Some("target" | "_build" | ".git" | "node_modules")
            ) {
                continue;
            }
            hash_path(&child, hash)?;
        }
    }
    Ok(())
}

struct Generation {
    cancel: CancellationToken,
    task: JoinHandle<Result<i32>>,
}
impl Generation {
    fn start(app: PreparedApp) -> Self {
        let cancel = CancellationToken::new();
        Self {
            task: tokio::spawn(app.run(cancel.clone())),
            cancel,
        }
    }
    async fn stop(mut self) {
        self.cancel.cancel();
        match (&mut self.task).await {
            Ok(Ok(0)) => {}
            result => eprintln!("generation stopped: {result:?}"),
        }
    }
}
impl Drop for Generation {
    fn drop(&mut self) {
        self.cancel.cancel();
        self.task.abort();
    }
}

pub async fn dev(path: &Path, cancel: CancellationToken) -> Result<i32> {
    let mut app = App::load(path)?;
    let mut previous = app.fingerprint()?;
    let mut generation: Option<Generation> = None;
    let mut rebuild = true;
    let mut pending_change = None;
    loop {
        if rebuild {
            rebuild = false;
            match App::load(&app.manifest) {
                Ok(next) => {
                    app = next;
                    // Snapshot before building: edits made during a build trigger
                    // another build rather than disappearing into the snapshot.
                    previous = app.fingerprint()?;
                    match app.build(&cancel).await {
                        Ok(()) if !cancel.is_cancelled() => {
                            // Compilation must not occupy an executor thread while the
                            // old generation is still serving requests.
                            let candidate = app.clone();
                            let validation =
                                tokio::task::spawn_blocking(move || candidate.prepare())
                                    .await
                                    .context("component validation task failed")
                                    .and_then(|result| result);
                            let prepared = match validation {
                                Ok(prepared) => prepared,
                                Err(error) => {
                                    eprintln!(
                                        "validation failed; keeping current generation: {error:#}"
                                    );
                                    continue;
                                }
                            };
                            if cancel.is_cancelled() {
                                break;
                            }
                            if let Some(old) = generation.take() {
                                old.stop().await;
                            }
                            eprintln!("starting application generation");
                            generation = Some(Generation::start(prepared));
                        }
                        Err(error) if !cancel.is_cancelled() => {
                            eprintln!("build failed; keeping current generation: {error:#}")
                        }
                        _ => {}
                    }
                }
                Err(error) => eprintln!("manifest invalid; keeping current generation: {error:#}"),
            }
        }
        tokio::select! {
            _ = cancel.cancelled() => break,
            _ = tokio::time::sleep(Duration::from_millis(100)) => {},
        }
        if generation
            .as_ref()
            .is_some_and(|generation| generation.task.is_finished())
        {
            if let Some(finished) = generation.take() {
                finished.stop().await;
            }
            eprintln!("application exited; waiting for changes");
        }
        match app.fingerprint() {
            Ok(current) if current != previous => {
                previous = current;
                pending_change = Some(tokio::time::Instant::now());
            }
            Ok(_) => {
                if pending_change
                    .is_some_and(|changed| changed.elapsed() >= Duration::from_millis(200))
                {
                    pending_change = None;
                    rebuild = true;
                }
            }
            Err(error) => eprintln!("watch failed: {error:#}"),
        }
    }
    if let Some(generation) = generation {
        generation.stop().await;
    }
    Ok(0)
}
