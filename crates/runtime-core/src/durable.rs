use crate::runtime::Host;
use anyhow::{Result, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tokio::sync::Semaphore;
use wasmtime::component::{Accessor, Linker, Resource};

mod bindings {
    wasmtime::component::bindgen!({
        path: "../../wit/durable", world: "client",
        imports: { default: async | trappable },
        with: { "wasmplane:durable/objects.object": super::ObjectHandle },
    });
}
use bindings::wasmplane::durable::objects;
pub use bindings::wasmplane::durable::objects::{
    Error as FetchError, Request as FetchRequest, Response as FetchResponse,
};

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GatewayBinding {
    pub endpoint: String,
    pub namespace: String,
    pub token_env: String,
}

struct Gateway {
    endpoint: reqwest::Url,
    namespace: String,
    authorization: reqwest::header::HeaderValue,
}

#[derive(Clone, Debug)]
pub struct ObjectHandle {
    binding: String,
    name: String,
}

pub struct DurableClient {
    gateways: BTreeMap<String, Gateway>,
    client: reqwest::Client,
    timeout: Duration,
    body_limit: usize,
    permits: Semaphore,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireRequest {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
}

impl DurableClient {
    pub fn new(
        bindings: BTreeMap<String, GatewayBinding>,
        secrets: impl Fn(&str) -> Option<String>,
        timeout_ms: u64,
        body_limit: usize,
        concurrency: usize,
    ) -> Result<Self> {
        ensure!(
            timeout_ms > 0 && concurrency > 0 && body_limit > 0 && body_limit <= 1024 * 1024,
            "invalid Durable Object limits (maximum body size: 1 MiB)"
        );
        let mut gateways = BTreeMap::new();
        for (name, binding) in bindings {
            let endpoint = reqwest::Url::parse(&binding.endpoint)?;
            ensure!(
                matches!(endpoint.scheme(), "http" | "https")
                    && endpoint.host_str().is_some()
                    && endpoint.username().is_empty()
                    && endpoint.password().is_none()
                    && endpoint.query().is_none()
                    && endpoint.fragment().is_none(),
                "invalid gateway endpoint"
            );
            ensure!(
                !binding.namespace.is_empty()
                    && binding.namespace.len() <= 64
                    && binding.namespace.as_bytes()[0].is_ascii_uppercase()
                    && binding
                        .namespace
                        .bytes()
                        .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_'),
                "invalid gateway namespace"
            );
            let token = secrets(&binding.token_env).ok_or_else(|| {
                anyhow::anyhow!(
                    "gateway secret environment variable is missing: {}",
                    binding.token_env
                )
            })?;
            ensure!(!token.is_empty(), "gateway token must not be empty");
            let mut authorization =
                reqwest::header::HeaderValue::from_str(&format!("Bearer {token}"))
                    .map_err(|_| anyhow::anyhow!("gateway token is not a valid header value"))?;
            authorization.set_sensitive(true);
            gateways.insert(
                name,
                Gateway {
                    endpoint,
                    namespace: binding.namespace,
                    authorization,
                },
            );
        }
        Ok(Self {
            gateways,
            client: reqwest::Client::builder()
                .no_proxy()
                .http1_only()
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            timeout: Duration::from_millis(timeout_ms),
            body_limit,
            permits: Semaphore::new(concurrency),
        })
    }

    pub fn open(&self, binding: &str, name: &str) -> Result<ObjectHandle, FetchError> {
        if !self.gateways.contains_key(binding) {
            return Err(FetchError::BindingDenied);
        }
        if name.is_empty()
            || name.len() > 512
            || matches!(name, "." | "..")
            || name.chars().any(char::is_control)
        {
            return Err(FetchError::InvalidRequest("invalid object name".into()));
        }
        Ok(ObjectHandle {
            binding: binding.into(),
            name: name.into(),
        })
    }

    pub async fn fetch(
        &self,
        object: &ObjectHandle,
        request: FetchRequest,
    ) -> Result<FetchResponse, FetchError> {
        validate_request(&request, self.body_limit)?;
        let gateway = self
            .gateways
            .get(&object.binding)
            .ok_or(FetchError::BindingDenied)?;
        let deadline = tokio::time::Instant::now() + self.timeout;
        let _permit = tokio::time::timeout_at(deadline, self.permits.acquire())
            .await
            .map_err(|_| FetchError::DeadlineExceeded)?
            .map_err(|_| FetchError::Unavailable)?;
        let mut url = gateway.endpoint.clone();
        url.path_segments_mut()
            .map_err(|_| FetchError::Unavailable)?
            .pop_if_empty()
            .extend(["v1", "objects", &gateway.namespace, &object.name, "fetch"]);
        let wire = WireRequest {
            method: request.method,
            path: request.path,
            headers: request.headers,
            body: STANDARD.encode(request.body),
            request_id: request.request_id,
        };
        let mut trace_headers = reqwest::header::HeaderMap::new();
        for (name, value) in &wire.headers {
            if name.eq_ignore_ascii_case("traceparent") || name.eq_ignore_ascii_case("tracestate") {
                trace_headers.append(
                    reqwest::header::HeaderName::from_bytes(name.as_bytes()).unwrap(),
                    value.parse().unwrap(),
                );
            }
        }
        // Never retry: an absent response does not establish that the actor did not commit.
        tokio::time::timeout_at(deadline, async {
            let mut response = self
                .client
                .post(url)
                .headers(trace_headers)
                .header(
                    reqwest::header::AUTHORIZATION,
                    gateway.authorization.clone(),
                )
                .json(&wire)
                .send()
                .await
                .map_err(|error| {
                    if error.is_connect() {
                        FetchError::Unavailable
                    } else {
                        FetchError::OutcomeUnknown
                    }
                })?;
            match response.status().as_u16() {
                200 => {}
                401 | 403 | 404 => return Err(FetchError::BindingDenied),
                400 => {
                    return Err(FetchError::InvalidRequest(
                        "gateway rejected request".into(),
                    ));
                }
                // A 413 can also be an oversized response after the actor committed.
                _ => return Err(FetchError::OutcomeUnknown),
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| FetchError::OutcomeUnknown)?
            {
                if bytes.len().saturating_add(chunk.len())
                    > self.body_limit.saturating_mul(2).saturating_add(65536)
                {
                    return Err(FetchError::OutcomeUnknown);
                }
                bytes.extend_from_slice(&chunk);
            }
            let wire: WireResponse =
                serde_json::from_slice(&bytes).map_err(|_| FetchError::OutcomeUnknown)?;
            if !(200..=599).contains(&wire.status) {
                return Err(FetchError::OutcomeUnknown);
            }
            let body = STANDARD
                .decode(wire.body)
                .map_err(|_| FetchError::OutcomeUnknown)?;
            if body.len() > self.body_limit {
                return Err(FetchError::OutcomeUnknown);
            }
            for (name, value) in &wire.headers {
                reqwest::header::HeaderName::from_bytes(name.as_bytes())
                    .map_err(|_| FetchError::OutcomeUnknown)?;
                reqwest::header::HeaderValue::from_str(value)
                    .map_err(|_| FetchError::OutcomeUnknown)?;
            }
            Ok(FetchResponse {
                status: wire.status,
                headers: wire.headers,
                body,
            })
        })
        .await
        .map_err(|_| FetchError::OutcomeUnknown)?
    }
}

fn validate_request(request: &FetchRequest, limit: usize) -> Result<(), FetchError> {
    let invalid = || FetchError::InvalidRequest("invalid method, path, headers or body".into());
    if !matches!(
        request.method.as_str(),
        "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS"
    ) || !request.path.starts_with('/')
        || request.path.starts_with("//")
        || request.path.contains(['\\', '\r', '\n', '#'])
        || request.body.len() > limit
        || (matches!(request.method.as_str(), "GET" | "HEAD") && !request.body.is_empty())
    {
        return Err(invalid());
    }
    for (name, value) in &request.headers {
        if matches!(
            name.to_ascii_lowercase().as_str(),
            "host"
                | "content-length"
                | "connection"
                | "transfer-encoding"
                | "upgrade"
                | "proxy-authorization"
                | "proxy-authenticate"
                | "keep-alive"
                | "te"
                | "trailer"
                | "x-wasmplane-request-id"
        ) {
            return Err(invalid());
        }
        reqwest::header::HeaderName::from_bytes(name.as_bytes()).map_err(|_| invalid())?;
        reqwest::header::HeaderValue::from_str(value).map_err(|_| invalid())?;
    }
    if let Some(id) = &request.request_id
        && (id.is_empty()
            || id.len() > 128
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b)))
    {
        return Err(invalid());
    }
    Ok(())
}

pub(crate) fn add_to_linker(linker: &mut Linker<Host>) -> wasmtime::Result<()> {
    bindings::Client::add_to_linker::<Host, Host>(linker, |host| host)
}
impl objects::Host for Host {
    async fn open(
        &mut self,
        binding: String,
        name: String,
    ) -> wasmtime::Result<Result<Resource<ObjectHandle>, FetchError>> {
        Ok(match self.durable.open(&binding, &name) {
            Ok(object) => Ok(self.table.push(object)?),
            Err(error) => Err(error),
        })
    }
}
impl objects::HostObject for Host {
    async fn drop(&mut self, object: Resource<ObjectHandle>) -> wasmtime::Result<()> {
        self.table.delete(object)?;
        Ok(())
    }
}
impl<T: Send> objects::HostObjectWithStore<T> for Host {
    async fn fetch(
        accessor: &Accessor<T, Self>,
        object: Resource<ObjectHandle>,
        mut request: FetchRequest,
    ) -> wasmtime::Result<Result<FetchResponse, FetchError>> {
        let (client, object, telemetry) = accessor.with(|mut access| {
            let host = access.get();
            Ok::<_, wasmtime::Error>((
                Arc::clone(&host.durable),
                host.table.get(&object)?.clone(),
                host.telemetry.clone(),
            ))
        })?;
        let mut headers = hyper::HeaderMap::new();
        for (name, value) in &request.headers {
            if let (Ok(name), Ok(value)) = (
                hyper::header::HeaderName::from_bytes(name.as_bytes()),
                value.parse::<hyper::header::HeaderValue>(),
            ) {
                headers.append(name, value);
            }
        }
        let parent = crate::telemetry::TraceContext::from_headers(&headers);
        let span = telemetry.start("durable.fetch", parent.as_ref(), 3, "durable");
        span.attribute(
            "wasmplane.durable.binding",
            serde_json::json!(object.binding),
        );
        span.context().inject(&mut headers);
        request.headers.retain(|(n, _)| {
            !n.eq_ignore_ascii_case("traceparent") && !n.eq_ignore_ascii_case("tracestate")
        });
        for name in ["traceparent", "tracestate"] {
            if let Some(value) = headers.get(name) {
                request
                    .headers
                    .push((name.into(), value.to_str().unwrap().into()));
            }
        }
        let result = client.fetch(&object, request).await;
        if let Ok(response) = &result {
            span.http_status(response.status);
        }
        span.finish(match &result {
            Ok(r) if r.status < 400 => "ok",
            Err(FetchError::OutcomeUnknown) => "outcome-unknown",
            Err(FetchError::DeadlineExceeded) => "timeout",
            _ => "error",
        });
        Ok(result)
    }
}
