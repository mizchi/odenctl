use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use wasmplane_wasip3_host::{HttpRequestInput, invoke_component_handle, precompile_component};

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let Some(command) = args.next() else {
        print_usage();
        bail!("missing command");
    };

    match command.as_str() {
        "compile" => {
            let component = required_path_arg(&mut args, "--component")?;
            let output = required_path_arg(&mut args, "--out")?;
            if args.next().is_some() {
                bail!("unexpected extra arguments");
            }
            let report = precompile_component(&component, &output)
                .with_context(|| format!("failed to precompile {}", component.display()))?;
            println!(
                "{{\"wasi\":\"{}\",\"component\":\"{}\",\"precompiled\":\"{}\",\"bytes\":{}}}",
                report.wasi_profile,
                json_escape(&report.component_path),
                json_escape(&report.precompiled_path),
                report.bytes
            );
            Ok(())
        }
        "invoke" => {
            let component = required_path_arg(&mut args, "--component")?;
            let method = required_string_arg(&mut args, "--method")?;
            let uri = required_string_arg(&mut args, "--uri")?;
            let body = optional_string_arg(&mut args, "--body")?.unwrap_or_default();
            if args.next().is_some() {
                bail!("unexpected extra arguments");
            }
            let response = invoke_component_handle(
                &component,
                HttpRequestInput {
                    method,
                    uri,
                    headers: Vec::new(),
                    body: body.into_bytes(),
                },
            )
            .with_context(|| format!("failed to invoke {}", component.display()))?;
            println!(
                "{{\"status\":{},\"headers\":{},\"body\":\"{}\"}}",
                response.status,
                headers_json(&response.headers),
                json_escape(&String::from_utf8_lossy(&response.body))
            );
            Ok(())
        }
        _ => {
            print_usage();
            bail!("unknown command {command}");
        }
    }
}

fn required_path_arg(args: &mut impl Iterator<Item = String>, name: &str) -> Result<PathBuf> {
    match (args.next(), args.next()) {
        (Some(flag), Some(value)) if flag == name => Ok(PathBuf::from(value)),
        _ => bail!("expected {name} <path>"),
    }
}

fn required_string_arg(args: &mut impl Iterator<Item = String>, name: &str) -> Result<String> {
    match (args.next(), args.next()) {
        (Some(flag), Some(value)) if flag == name => Ok(value),
        _ => bail!("expected {name} <value>"),
    }
}

fn optional_string_arg(
    args: &mut impl Iterator<Item = String>,
    name: &str,
) -> Result<Option<String>> {
    let Some(flag) = args.next() else {
        return Ok(None);
    };
    if flag != name {
        bail!("expected {name} <value>");
    }
    let Some(value) = args.next() else {
        bail!("expected {name} <value>");
    };
    Ok(Some(value))
}

fn print_usage() {
    eprintln!("usage:");
    eprintln!(
        "  wasmplane-wasip3-host compile --component <component.wasm> --out <component.cwasm>"
    );
    eprintln!(
        "  wasmplane-wasip3-host invoke --component <component.wasm> --method <METHOD> --uri <URI> [--body <TEXT>]"
    );
}

fn json_escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn headers_json(headers: &[(String, String)]) -> String {
    let items = headers
        .iter()
        .map(|(name, value)| {
            format!(
                "{{\"name\":\"{}\",\"value\":\"{}\"}}",
                json_escape(name),
                json_escape(value)
            )
        })
        .collect::<Vec<_>>();
    format!("[{}]", items.join(","))
}
