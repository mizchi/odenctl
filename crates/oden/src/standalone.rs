use anyhow::{Context, Result, bail};
use std::path::PathBuf;
use tokio_util::sync::CancellationToken;
use oden_core::server::HttpServer;
use oden_core::service::{ResidentService, ServiceOptions};
use oden_core::{config::RuntimeConfig, engine, runtime::Runtime};

fn main() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    let code = match runtime.block_on(run()) {
        Ok(code) => code,
        Err(error) => {
            eprintln!("{error:#}");
            1
        }
    };
    drop(runtime);
    std::process::exit(code);
}

async fn run() -> Result<i32> {
    let mut args = std::env::args().skip(1);
    let command = args.next().unwrap_or_else(|| "--help".into());
    if command == "--version" {
        println!(
            "oden {} (Wasmtime {}, {}, build {})",
            env!("CARGO_PKG_VERSION"),
            engine::VERSION,
            engine::TARGET,
            engine::BUILD
        );
        return Ok(0);
    }
    if command == "--help" {
        println!("oden init <directory> [--language rust|moonbit]");
        println!("oden inspect <component> [--json]");
        println!("oden check <app.json> [--json]");
        println!("oden run <component> [--config <json>] [--timeout-ms <ms>] [-- <args>]");
        println!("oden test <component> [--filter <text>] [--list] [--json] [--config <json>] [--timeout-ms <ms>]");
        println!(
            "oden serve <component> [--resident] [--addr 127.0.0.1:8080] [--config <json>]"
        );
        println!("oden build|start|dev <app.json>");
        println!(
            "<component> accepts .wasm binaries or .wat component text directly; no conversion tool is needed."
        );
        return Ok(0);
    }
    if command == "init" {
        let directory = PathBuf::from(args.next().context("missing project directory")?);
        let mut language = "rust".to_owned();
        while let Some(flag) = args.next() {
            if flag != "--language" {
                bail!("unknown init option {flag}");
            }
            language = args.next().context("missing language")?;
        }
        scaffold::init(&directory, &language)?;
        return Ok(0);
    }
    if matches!(command.as_str(), "check" | "inspect") {
        let path = PathBuf::from(args.next().context("missing input path")?);
        let json = if let Some(flag) = args.next() {
            if flag != "--json" || args.next().is_some() {
                bail!("expected optional --json");
            }
            true
        } else {
            false
        };
        if command == "check" {
            let report = app::check(&path);
            if json {
                println!("{}", serde_json::to_string_pretty(&report)?);
            } else {
                println!(
                    "{}: {}",
                    if report.valid { "OK" } else { "FAILED" },
                    path.display()
                );
                if let Some(component) = &report.component {
                    print_component(component);
                }
                println!("grants: {}", serde_json::to_string(&report.grants)?);
                for error in &report.errors {
                    println!("error: {error}");
                }
            }
            return Ok(if report.valid { 0 } else { 1 });
        }
        let component = oden_core::component::CheckedComponent::load(
            Runtime::new(RuntimeConfig::default())?,
            &path,
        )?;
        if json {
            println!("{}", serde_json::to_string_pretty(&component.report)?);
        } else {
            print_component(&component.report);
        }
        return Ok(0);
    }
    if command == "test" {
        return tokio::select! {
            result = test_command::run(args) => result,
            code = shutdown_signal() => code,
        };
    }
    if matches!(command.as_str(), "build" | "start" | "dev") {
        let path = PathBuf::from(args.next().context("missing app manifest path")?);
        if let Some(argument) = args.next() {
            bail!("unexpected argument {argument}");
        }
        let cancel = CancellationToken::new();
        let _guard = cancel.clone().drop_guard();
        let work = async {
            match command.as_str() {
                "build" => {
                    app::App::load(&path)?.build(&cancel).await?;
                    Ok(0)
                }
                "start" => app::App::load(&path)?.run(cancel.clone()).await,
                _ => app::dev(&path, cancel.clone()).await,
            }
        };
        tokio::pin!(work);
        return tokio::select! {
            biased;
            signal = shutdown_signal() => {
                let code = signal?;
                cancel.cancel();
                let result = work.await;
                if command == "build" { Ok(code) } else { result }
            },
            result = &mut work => result,
        };
    }
    if !matches!(command.as_str(), "run" | "serve") {
        bail!("unknown command {command}");
    }
    let component = PathBuf::from(args.next().context("missing component path")?);
    let mut config = RuntimeConfig::default();
    let mut timeout = None;
    let mut address = "127.0.0.1:8080".to_owned();
    let mut resident = false;
    let mut guest_args = vec![component.to_string_lossy().into_owned()];
    while let Some(flag) = args.next() {
        match flag.as_str() {
            "--config" => {
                config = serde_json::from_slice(&std::fs::read(
                    args.next().context("missing config path")?,
                )?)?
            }
            "--timeout-ms" => timeout = Some(args.next().context("missing timeout")?.parse()?),
            "--addr" => address = args.next().context("missing listen address")?,
            "--resident" => resident = true,
            "--" => {
                guest_args.extend(args);
                break;
            }
            _ => bail!("unknown option {flag}"),
        }
    }
    if let Some(timeout) = timeout {
        config.timeout_ms = timeout;
    }
    if resident && command != "serve" {
        bail!("--resident requires serve");
    }
    let runtime = Runtime::new(config)?;
    let telemetry = runtime.telemetry.clone();
    let result = async {
    match command.as_str() {
        "run" => tokio::select! {
            result = runtime.run(&component, &guest_args) => result,
            code = shutdown_signal() => code,
        },
        "serve" => {
            if resident {
                let listener = tokio::net::TcpListener::bind(address).await?;
                let shutdown = shutdown_signal();
                tokio::pin!(shutdown);
                let service = tokio::select! {
                    biased;
                    code = &mut shutdown => return code,
                    service = ResidentService::start(runtime, &component, ServiceOptions::default()) => service?,
                };
                eprintln!("listening on http://{}", listener.local_addr()?);
                service
                    .serve(listener, async {
                        let _ = shutdown.await;
                    })
                    .await?;
                return Ok(0);
            }
            let server = HttpServer::new(runtime, &component)?;
            let listener = tokio::net::TcpListener::bind(address).await?;
            eprintln!("listening on http://{}", listener.local_addr()?);
            server
                .serve(listener, async {
                    let _ = shutdown_signal().await;
                })
                .await?;
            Ok(0)
        }
        _ => bail!("unknown command {command}"),
    }
    }.await;
    telemetry.flush().await;
    result
}

fn print_component(report: &oden_core::component::ComponentReport) {
    println!("sha256: {}", report.sha256);
    println!(
        "compatible modes: {}",
        serde_json::to_string(&report.compatible_modes).unwrap()
    );
    for (direction, interfaces) in [("import", &report.imports), ("export", &report.exports)] {
        for interface in interfaces {
            println!("{direction} {} ({})", interface.name, interface.kind);
            if !interface.members.is_empty() {
                println!("  {}", interface.members.join(", "));
            }
        }
    }
    for error in &report.link_errors {
        println!("link error: {error}");
    }
}

async fn shutdown_signal() -> Result<i32> {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        tokio::select! {
            signal = tokio::signal::ctrl_c() => { signal?; Ok(130) },
            _ = terminate.recv() => Ok(143),
        }
    }
    #[cfg(not(unix))]
    {
        tokio::signal::ctrl_c().await?;
        Ok(130)
    }
}
mod app;
mod scaffold;
mod test_command;
