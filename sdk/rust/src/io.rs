//! Buffered I/O helpers. All access is subject to the host's explicit grants.
use crate::{types, wasip3};
use wasip3::filesystem::{preopens, types as fs};
use wasip3::wit_bindgen::rt::async_support::{StreamReader, StreamResult};

#[derive(Debug)]
pub enum IoError {
    InvalidPath,
    NotPreopened,
    BodyTooLarge,
    File(fs::ErrorCode),
    Http(types::ErrorCode),
    InvalidRequest,
    Header(types::HeaderError),
}

pub fn env(name: &str) -> Option<String> {
    wasip3::cli::environment::get_environment()
        .into_iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value)
}

/// Guest paths must be absolute; dot segments and NUL are rejected.
fn relative_to<'a>(path: &'a str, root: &str) -> Option<&'a str> {
    let root = root.trim_end_matches('/');
    if root.is_empty() {
        return path.strip_prefix('/');
    }
    path.strip_prefix(root)?.strip_prefix('/')
}
async fn open(path: &str, write: bool) -> Result<fs::Descriptor, IoError> {
    if !path.starts_with('/')
        || path.contains('\0')
        || path.split('/').any(|p| p == ".." || p == ".")
    {
        return Err(IoError::InvalidPath);
    }
    let (directory, root) = preopens::get_directories()
        .into_iter()
        .filter(|(_, root)| relative_to(path, root).is_some())
        .max_by_key(|(_, root)| root.trim_end_matches('/').len())
        .ok_or(IoError::NotPreopened)?;
    let name = relative_to(path, &root).unwrap().to_owned();
    directory
        .open_at(
            fs::PathFlags::empty(),
            name,
            if write {
                fs::OpenFlags::CREATE | fs::OpenFlags::TRUNCATE
            } else {
                fs::OpenFlags::empty()
            },
            if write {
                fs::DescriptorFlags::WRITE
            } else {
                fs::DescriptorFlags::READ
            },
        )
        .await
        .map_err(IoError::File)
}

async fn read_bounded(mut stream: StreamReader<u8>, limit: usize) -> Result<Vec<u8>, IoError> {
    let mut output = Vec::new();
    loop {
        // Read at most one byte beyond the limit, without reserving `limit` bytes.
        let capacity = limit
            .saturating_sub(output.len())
            .saturating_add(1)
            .min(16 * 1024);
        let (status, chunk) = stream.read(Vec::with_capacity(capacity)).await;
        if chunk.len() > limit - output.len() {
            return Err(IoError::BodyTooLarge);
        }
        output.extend(chunk);
        if matches!(status, StreamResult::Dropped) {
            return Ok(output);
        }
    }
}

pub async fn read_file(path: &str, limit: usize) -> Result<Vec<u8>, IoError> {
    let file = open(path, false).await?;
    let (stream, finished) = file.read_via_stream(0);
    let bytes = read_bounded(stream, limit).await?;
    finished.await.map_err(IoError::File)?;
    Ok(bytes)
}

pub async fn write_file(path: &str, bytes: Vec<u8>) -> Result<(), IoError> {
    let file = open(path, true).await?;
    let (mut writer, reader) = wasip3::wit_stream::new();
    wasip3::wit_bindgen::spawn_local(async move {
        let _ = writer.write_all(bytes).await;
    });
    file.write_via_stream(reader, 0)
        .await
        .map_err(IoError::File)
}

/// HTTP target follows WASI's scheme/authority/path contract; no implicit redirects.
pub struct HttpRequest {
    pub method: types::Method,
    pub scheme: types::Scheme,
    pub authority: String,
    pub path: String,
    pub headers: Vec<(String, Vec<u8>)>,
    pub body: Vec<u8>,
}
#[derive(Debug)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, Vec<u8>)>,
    pub body: Vec<u8>,
}

pub async fn fetch(input: HttpRequest, limit: usize) -> Result<HttpResponse, IoError> {
    let headers = types::Fields::from_list(&input.headers).map_err(IoError::Header)?;
    let (mut writer, reader) = wasip3::wit_stream::new();
    let (trailers_tx, trailers_rx) = wasip3::wit_future::new(|| Ok(None));
    drop(trailers_tx);
    let (request, sent) = types::Request::new(headers, Some(reader), trailers_rx, None);
    request
        .set_method(&input.method)
        .map_err(|_| IoError::InvalidRequest)?;
    request
        .set_scheme(Some(&input.scheme))
        .map_err(|_| IoError::InvalidRequest)?;
    request
        .set_authority(Some(&input.authority))
        .map_err(|_| IoError::InvalidRequest)?;
    request
        .set_path_with_query(Some(&input.path))
        .map_err(|_| IoError::InvalidRequest)?;
    wasip3::wit_bindgen::spawn_local(async move {
        let _ = writer.write_all(input.body).await;
    });
    let response = wasip3::http::client::send(request)
        .await
        .map_err(IoError::Http)?;
    let status = response.get_status_code();
    let headers = response.get_headers().copy_all();
    let (done_tx, done_rx) = wasip3::wit_future::new(|| Ok(()));
    let (body, trailers) = types::Response::consume_body(response, done_rx);
    let body = read_bounded(body, limit).await?;
    drop(trailers.await.map_err(IoError::Http)?);
    sent.await.map_err(IoError::Http)?;
    drop(done_tx);
    Ok(HttpResponse {
        status,
        headers,
        body,
    })
}

/// Inject an explicitly captured task context; the host creates the client span.
pub async fn fetch_traced(
    context: &crate::telemetry::Context,
    mut input: HttpRequest,
    limit: usize,
) -> Result<HttpResponse, IoError> {
    crate::telemetry::inject(context, &mut input.headers);
    fetch(input, limit).await
}
