//! Shared conformance/demo routes for the SDK's capability-based I/O.
use serde_json::{Value, json};
use oden_service_sdk::{durable, io, types};

pub async fn handle(path: &str) -> Option<Value> {
    if !path.starts_with("/io/") {
        return None;
    }
    Some(match path {
        "/io/env" => {
            json!({ "value": io::env("IO_VALUE"), "missing": io::env("UNGRANTED_ENV").is_none() })
        }
        "/io/read" => match io::read_file("/data/input.txt", 1024).await {
            Ok(bytes) => json!({ "value": String::from_utf8(bytes).unwrap() }),
            Err(e) => json!({ "error": format!("{e:?}") }),
        },
        "/io/write" => {
            json!({ "ok": io::write_file("/data/output.txt", "written 日本語".as_bytes().to_vec()).await.is_ok() })
        }
        "/io/readonly" => {
            json!({ "rejected": io::write_file("/readonly/output.txt", vec![]).await.is_err() })
        }
        "/io/read-limit" => {
            json!({ "rejected": matches!(io::read_file("/data/input.txt", 1).await, Err(io::IoError::BodyTooLarge)) })
        }
        "/io/escape" | "/io/parent" | "/io/missing" | "/io/ungranted" => {
            let file = match path {
                "/io/escape" => "/data/escape.txt",
                "/io/parent" => "/data/../outside.txt",
                "/io/missing" => "/data/missing.txt",
                _ => "/ungranted/file",
            };
            json!({ "rejected": io::read_file(file, 1024).await.is_err() })
        }
        "/io/fetch" | "/io/http-denied" | "/io/http-limit" => {
            let result = io::fetch(
                io::HttpRequest {
                    method: types::Method::Post,
                    scheme: types::Scheme::Http,
                    authority: if path == "/io/http-denied" {
                        io::env("IO_DENIED_AUTHORITY").unwrap()
                    } else {
                        io::env("IO_AUTHORITY").unwrap()
                    },
                    path: "/echo".into(),
                    headers: vec![("x-sdk".into(), b"yes".to_vec())],
                    body: "payload 日本語".as_bytes().to_vec(),
                },
                if path == "/io/http-limit" { 1 } else { 1024 },
            )
            .await;
            if path == "/io/fetch" {
                match result {
                    Ok(response) => {
                        json!({ "status": response.status, "header": response.headers.iter().any(|(k,v)| k == "x-upstream" && v == b"yes"), "value": String::from_utf8(response.body).unwrap() })
                    }
                    Err(e) => json!({ "error": format!("{e:?}") }),
                }
            } else if path == "/io/http-limit" {
                json!({ "rejected": matches!(result, Err(io::IoError::BodyTooLarge)) })
            } else {
                json!({ "rejected": matches!(result, Err(io::IoError::Http(types::ErrorCode::HttpRequestDenied))) })
            }
        }
        "/io/durable-denied" | "/io/durable" => {
            let result = durable::fetch(
                if path == "/io/durable-denied" {
                    "ungranted"
                } else {
                    "counter"
                },
                "sdk-shared",
                durable::Request {
                    method: "POST".into(),
                    path: "/increment".into(),
                    headers: vec![],
                    body: vec![],
                    request_id: None,
                },
            )
            .await;
            if path == "/io/durable-denied" {
                json!({ "rejected": matches!(result, Err(durable::Error::BindingDenied)) })
            } else {
                match result {
                    Ok(response) => serde_json::from_slice(&response.body).unwrap(),
                    Err(e) => json!({ "error": format!("{e:?}") }),
                }
            }
        }
        _ => json!({ "error": "unknown I/O example" }),
    })
}
