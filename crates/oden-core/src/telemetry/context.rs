use serde::{Deserialize, Serialize};

/// A value, never a Store-global current span. Safe to copy across async tasks.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TraceContext {
    pub trace_id: String,
    pub span_id: String,
    pub flags: u8,
    pub tracestate: String,
}
impl TraceContext {
    pub fn parse(parent: &str, state: &str) -> Option<Self> {
        let parts: Vec<_> = parent.split('-').collect();
        let hex = |value: &str, length| {
            value.len() == length
                && value
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        };
        if parts.len() < 4
            || !hex(parts[0], 2)
            || parts[0] == "ff"
            || (parts[0] == "00" && parts.len() != 4)
            || !hex(parts[1], 32)
            || !hex(parts[2], 16)
            || !hex(parts[3], 2)
            || parts[1].bytes().all(|b| b == b'0')
            || parts[2].bytes().all(|b| b == b'0')
            || parts[4..].iter().any(|p| p.is_empty())
        {
            return None;
        }
        Some(Self {
            trace_id: parts[1].into(),
            span_id: parts[2].into(),
            flags: u8::from_str_radix(parts[3], 16).ok()? & 1,
            tracestate: valid_state(state).unwrap_or_default(),
        })
    }
    pub fn traceparent(&self) -> String {
        format!(
            "00-{}-{}-{:02x}",
            self.trace_id,
            self.span_id,
            self.flags & 1
        )
    }
    pub fn from_headers(headers: &hyper::HeaderMap) -> Option<Self> {
        if headers.get_all("traceparent").iter().count() != 1 {
            return None;
        }
        let state = headers
            .get_all("tracestate")
            .iter()
            .filter_map(|v| v.to_str().ok())
            .collect::<Vec<_>>()
            .join(",");
        Self::parse(headers.get("traceparent")?.to_str().ok()?, &state)
    }
    pub fn inject(&self, headers: &mut hyper::HeaderMap) {
        headers.insert("traceparent", self.traceparent().parse().unwrap());
        headers.remove("tracestate");
        if !self.tracestate.is_empty() {
            headers.insert("tracestate", self.tracestate.parse().unwrap());
        }
    }
}

fn valid_state(state: &str) -> Option<String> {
    if state.is_empty() {
        return Some(String::new());
    }
    if state.len() > 512 {
        return None;
    }
    let mut keys = std::collections::HashSet::new();
    let mut normalized = Vec::new();
    for member in state.split(',') {
        let (key, value) = member.trim_matches([' ', '\t']).split_once('=')?;
        let key_char = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit() || b"_-*/".contains(&b);
        let valid_key = if let Some((tenant, system)) = key.split_once('@') {
            !tenant.is_empty()
                && tenant.len() <= 241
                && tenant.bytes().all(key_char)
                && tenant.as_bytes()[0].is_ascii_alphanumeric()
                && !system.is_empty()
                && system.len() <= 14
                && system.as_bytes()[0].is_ascii_lowercase()
                && system.bytes().all(key_char)
        } else {
            !key.is_empty()
                && key.len() <= 256
                && key.as_bytes()[0].is_ascii_lowercase()
                && key.bytes().all(key_char)
        };
        if !valid_key
            || !keys.insert(key)
            || keys.len() > 32
            || value.is_empty()
            || value.len() > 256
            || value.ends_with(' ')
            || !value
                .bytes()
                .all(|b| (0x20..=0x7e).contains(&b) && b != b',' && b != b'=')
        {
            return None;
        }
        normalized.push(format!("{key}={value}"));
    }
    Some(normalized.join(","))
}
