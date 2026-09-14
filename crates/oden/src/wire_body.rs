//! The node JSON protocol preserves text and carries binary bodies as base64.
use anyhow::{Context, Result, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Map, Value};

pub fn decode_base64(value: &str) -> Result<Vec<u8>> {
    STANDARD
        .decode(value)
        .context("bodyBase64 must be canonical padded base64")
}

pub fn decode(object: &Map<String, Value>) -> Result<Vec<u8>> {
    match (object.get("body"), object.get("bodyBase64")) {
        (Some(_), Some(_)) => bail!("body and bodyBase64 are mutually exclusive"),
        (Some(value), None) => Ok(value
            .as_str()
            .context("body must be a string")?
            .as_bytes()
            .to_vec()),
        (None, Some(value)) => {
            decode_base64(value.as_str().context("bodyBase64 must be a string")?)
        }
        (None, None) => Ok(Vec::new()),
    }
}

pub fn encode(body: &[u8]) -> (&'static str, String) {
    match std::str::from_utf8(body) {
        Ok(text) if !text.contains('\0') => ("body", text.to_owned()),
        _ => ("bodyBase64", STANDARD.encode(body)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arbitrary_bytes_and_text_round_trip_without_replacement() {
        for bytes in [
            vec![],
            (0..=255).collect(),
            b"with\0nul".to_vec(),
            "hello 日本語".as_bytes().to_vec(),
        ] {
            let (key, value) = encode(&bytes);
            let mut json = Map::new();
            json.insert(key.to_owned(), value.into());
            assert_eq!(decode(&json).unwrap(), bytes);
        }
    }

    #[test]
    fn malformed_or_ambiguous_payloads_are_rejected() {
        for value in [
            serde_json::json!({"body": "text", "bodyBase64": "AA=="}),
            serde_json::json!({"body": null}),
            serde_json::json!({"bodyBase64": 42}),
            serde_json::json!({"bodyBase64": "%%%"}),
            serde_json::json!({"bodyBase64": "AB=="}),
            serde_json::json!({"bodyBase64": "AA"}),
        ] {
            assert!(decode(value.as_object().unwrap()).is_err());
        }
    }
}
