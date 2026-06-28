use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use serde_json::Value;
use wasmplane_wasip3_host::{
    HostPolicy, HttpRequestInput, InvocationLimits, KvBindingPolicy, OutboundHttpPolicy,
    SecretBindingPolicy, invoke_component_handle_with_limits_and_policy, precompile_component,
};

struct InvokeArgs {
    component: PathBuf,
    method: String,
    uri: String,
    headers: Vec<(String, String)>,
    body: String,
    limits: InvocationLimits,
    policy: HostPolicy,
    kv_store_dir: Option<PathBuf>,
}

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
            let invoke_args = parse_invoke_args(&mut args)?;
            let request = HttpRequestInput {
                method: invoke_args.method,
                uri: invoke_args.uri,
                headers: invoke_args.headers,
                body: invoke_args.body.into_bytes(),
            };
            let response = match invoke_args.kv_store_dir {
                Some(kv_store_dir) => {
                    wasmplane_wasip3_host::invoke_component_handle_with_persistent_kv(
                        &invoke_args.component,
                        request,
                        invoke_args.limits,
                        invoke_args.policy,
                        &kv_store_dir,
                    )
                }
                None => invoke_component_handle_with_limits_and_policy(
                    &invoke_args.component,
                    request,
                    invoke_args.limits,
                    invoke_args.policy,
                ),
            }
            .with_context(|| format!("failed to invoke {}", invoke_args.component.display()))?;
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

fn parse_invoke_args(args: &mut impl Iterator<Item = String>) -> Result<InvokeArgs> {
    let mut component = None;
    let mut method = None;
    let mut uri = None;
    let mut headers = Vec::new();
    let mut body = String::new();
    let mut limits = InvocationLimits::default();
    let mut policy = HostPolicy::deny_all();
    let mut kv_store_dir = None;

    while let Some(flag) = args.next() {
        let Some(value) = args.next() else {
            bail!("expected {flag} <value>");
        };
        match flag.as_str() {
            "--component" => component = Some(PathBuf::from(value)),
            "--method" => method = Some(value),
            "--uri" => uri = Some(value),
            "--headers" => headers = parse_headers_arg(&value)?,
            "--body" => body = value,
            "--wall-ms" => limits.wall_ms = Some(parse_u64(&value, "--wall-ms")?),
            "--memory-mb" => limits.memory_mb = Some(parse_u64(&value, "--memory-mb")?),
            "--request-bytes" => {
                limits.request_bytes = Some(parse_usize(&value, "--request-bytes")?)
            }
            "--response-bytes" => {
                limits.response_bytes = Some(parse_usize(&value, "--response-bytes")?)
            }
            "--subrequests" => limits.subrequests = Some(parse_u32(&value, "--subrequests")?),
            "--host-calls" => limits.host_calls = Some(parse_u32(&value, "--host-calls")?),
            "--capabilities" => policy = parse_host_policy(&value)?,
            "--kv-store-dir" => kv_store_dir = Some(PathBuf::from(value)),
            _ => bail!("unexpected argument {flag}"),
        }
    }

    Ok(InvokeArgs {
        component: component.context("expected --component <path>")?,
        method: method.context("expected --method <value>")?,
        uri: uri.context("expected --uri <value>")?,
        headers,
        body,
        limits,
        policy,
        kv_store_dir,
    })
}

fn required_path_arg(args: &mut impl Iterator<Item = String>, name: &str) -> Result<PathBuf> {
    match (args.next(), args.next()) {
        (Some(flag), Some(value)) if flag == name => Ok(PathBuf::from(value)),
        _ => bail!("expected {name} <path>"),
    }
}

fn parse_u64(value: &str, name: &str) -> Result<u64> {
    let value = value
        .parse::<u64>()
        .with_context(|| format!("{name} must be a positive integer"))?;
    if value == 0 {
        bail!("{name} must be a positive integer");
    }
    Ok(value)
}

fn parse_u32(value: &str, name: &str) -> Result<u32> {
    let value = value
        .parse::<u32>()
        .with_context(|| format!("{name} must be a positive integer"))?;
    if value == 0 {
        bail!("{name} must be a positive integer");
    }
    Ok(value)
}

fn parse_usize(value: &str, name: &str) -> Result<usize> {
    let value = value
        .parse::<usize>()
        .with_context(|| format!("{name} must be a positive integer"))?;
    if value == 0 {
        bail!("{name} must be a positive integer");
    }
    Ok(value)
}

fn parse_headers_arg(value: &str) -> Result<Vec<(String, String)>> {
    let json: Value = serde_json::from_str(value).context("--headers must be valid JSON")?;
    let Value::Array(items) = json else {
        bail!("--headers must be a JSON array");
    };
    items
        .iter()
        .map(|item| {
            let name = item
                .get("name")
                .and_then(Value::as_str)
                .context("--headers entries must include name")?;
            let value = item
                .get("value")
                .and_then(Value::as_str)
                .context("--headers entries must include value")?;
            Ok((name.to_string(), value.to_string()))
        })
        .collect()
}

fn parse_host_policy(value: &str) -> Result<HostPolicy> {
    let json: Value = serde_json::from_str(value).context("--capabilities must be valid JSON")?;
    if !json.is_object() {
        bail!("--capabilities must be a JSON object");
    }
    reject_privileged_capability(&json, "arbitraryFilesystem")?;
    reject_privileged_capability(&json, "arbitrarySockets")?;
    reject_privileged_capability(&json, "processSpawn")?;

    let outbound_http = json
        .get("outboundHttp")
        .map(parse_outbound_http_policy)
        .transpose()?
        .unwrap_or_else(OutboundHttpPolicy::disabled);
    let kv_bindings = parse_kv_bindings(json.get("kv"))?;
    let secret_bindings = parse_secret_bindings(json.get("secrets"))?;

    Ok(HostPolicy::with_bindings(
        outbound_http,
        kv_bindings,
        secret_bindings,
    ))
}

fn reject_privileged_capability(json: &Value, field: &str) -> Result<()> {
    if json.get(field).and_then(Value::as_bool).unwrap_or(false) {
        bail!("{field} is not allowed for workers");
    }
    Ok(())
}

fn parse_outbound_http_policy(value: &Value) -> Result<OutboundHttpPolicy> {
    if !value.is_object() {
        bail!("capabilities.outboundHttp must be an object");
    }
    let enabled = value
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let allow = match value.get("allow") {
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| {
                item.as_str()
                    .map(str::to_string)
                    .context("capabilities.outboundHttp.allow entries must be strings")
            })
            .collect::<Result<Vec<_>>>()?,
        None => Vec::new(),
        _ => bail!("capabilities.outboundHttp.allow must be an array"),
    };
    if !enabled && !allow.is_empty() {
        bail!("outbound allowlist requires outboundHttp.enabled");
    }
    if enabled {
        Ok(OutboundHttpPolicy::enabled(allow))
    } else {
        Ok(OutboundHttpPolicy::disabled())
    }
}

fn parse_kv_bindings(value: Option<&Value>) -> Result<Vec<KvBindingPolicy>> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let Value::Array(items) = value else {
        bail!("capabilities.kv must be an array");
    };
    items
        .iter()
        .map(|item| {
            let binding = item
                .get("binding")
                .and_then(Value::as_str)
                .context("capabilities.kv entries must include binding")?;
            let namespace_id = item
                .get("namespaceId")
                .and_then(Value::as_str)
                .context("capabilities.kv entries must include namespaceId")?;
            Ok(KvBindingPolicy::new(binding, namespace_id))
        })
        .collect()
}

fn parse_secret_bindings(value: Option<&Value>) -> Result<Vec<SecretBindingPolicy>> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let Value::Array(items) = value else {
        bail!("capabilities.secrets must be an array");
    };
    items
        .iter()
        .map(|item| {
            let binding = item
                .get("binding")
                .and_then(Value::as_str)
                .context("capabilities.secrets entries must include binding")?;
            let secret_id = item
                .get("secretId")
                .and_then(Value::as_str)
                .context("capabilities.secrets entries must include secretId")?;
            let value = item.get("value").and_then(Value::as_str);
            Ok(match value {
                Some(value) => SecretBindingPolicy::with_value(binding, secret_id, value),
                None => SecretBindingPolicy::new(binding, secret_id),
            })
        })
        .collect()
}

fn print_usage() {
    eprintln!("usage:");
    eprintln!(
        "  wasmplane-wasip3-host compile --component <component.wasm> --out <component.cwasm>"
    );
    eprintln!(
        "  wasmplane-wasip3-host invoke --component <component.wasm> --method <METHOD> --uri <URI> [--headers <JSON>] [--body <TEXT>] [--wall-ms <MS>] [--memory-mb <MB>] [--request-bytes <BYTES>] [--response-bytes <BYTES>] [--subrequests <COUNT>] [--host-calls <COUNT>] [--capabilities <JSON>] [--kv-store-dir <DIR>]"
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_invoke_args_accepts_runtime_limits_and_capabilities() {
        let capabilities = r#"{
            "outboundHttp": { "enabled": true, "allow": ["https://api.example.dev/"] },
            "kv": [{ "binding": "KV", "namespaceId": "kv_main" }],
            "secrets": [{ "binding": "API_KEY", "secretId": "sec_api_key", "value": "super-secret" }],
            "arbitraryFilesystem": false,
            "arbitrarySockets": false,
            "processSpawn": false
        }"#;
        let kv_store_dir = std::env::temp_dir().join("wasmplane-cli-kv-store");
        let mut args = vec![
            "--component",
            "/tmp/worker.component.wasm",
            "--method",
            "POST",
            "--uri",
            "https://worker.example.dev/",
            "--headers",
            r#"[{"name":"x-upstream-url","value":"http://127.0.0.1:3000/probe"}]"#,
            "--body",
            "payload",
            "--wall-ms",
            "1000",
            "--memory-mb",
            "64",
            "--request-bytes",
            "1048576",
            "--response-bytes",
            "1048576",
            "--subrequests",
            "20",
            "--host-calls",
            "100",
            "--capabilities",
            capabilities,
            "--kv-store-dir",
            kv_store_dir.to_str().expect("utf8 kv store path"),
        ]
        .into_iter()
        .map(String::from);

        let parsed = parse_invoke_args(&mut args).expect("invoke args");

        assert_eq!(
            parsed.component,
            PathBuf::from("/tmp/worker.component.wasm")
        );
        assert_eq!(parsed.method, "POST");
        assert_eq!(parsed.uri, "https://worker.example.dev/");
        assert_eq!(
            parsed.headers,
            vec![(
                "x-upstream-url".to_string(),
                "http://127.0.0.1:3000/probe".to_string()
            )]
        );
        assert_eq!(parsed.body, "payload");
        assert_eq!(parsed.limits.wall_ms, Some(1000));
        assert_eq!(parsed.limits.memory_mb, Some(64));
        assert_eq!(parsed.limits.request_bytes, Some(1048576));
        assert_eq!(parsed.limits.response_bytes, Some(1048576));
        assert_eq!(parsed.limits.subrequests, Some(20));
        assert_eq!(parsed.limits.host_calls, Some(100));
        assert!(
            parsed
                .policy
                .allows_outbound_uri("https://api.example.dev/users")
        );
        assert_eq!(
            parsed.policy.kv_namespace_for_binding("KV"),
            Some("kv_main")
        );
        assert!(parsed.policy.secret_for_binding("API_KEY").is_some());
        assert_eq!(parsed.kv_store_dir, Some(kv_store_dir));
    }

    #[test]
    fn parse_host_policy_rejects_privileged_capabilities() {
        let error = parse_host_policy(
            r#"{
                "outboundHttp": { "enabled": false, "allow": [] },
                "kv": [],
                "secrets": [],
                "arbitraryFilesystem": false,
                "arbitrarySockets": true,
                "processSpawn": false
            }"#,
        )
        .expect_err("privileged socket access should be denied");

        assert!(format!("{error:?}").contains("arbitrarySockets is not allowed"));
    }
}
