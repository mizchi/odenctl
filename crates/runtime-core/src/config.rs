use anyhow::{Result, ensure};
use serde::Deserialize;
use std::{collections::BTreeMap, path::PathBuf};

#[derive(Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct RuntimeConfig {
    pub timeout_ms: u64,
    pub memory_mb: usize,
    pub max_body_bytes: usize,
    pub max_concurrent_requests: usize,
    pub env: BTreeMap<String, String>,
    pub directories: Vec<DirectoryGrant>,
    pub outbound_origins: Vec<String>,
    pub durable: BTreeMap<String, crate::durable::GatewayBinding>,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DirectoryGrant {
    pub host: PathBuf,
    pub guest: String,
    #[serde(default)]
    pub write: bool,
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        Self {
            timeout_ms: 30_000,
            memory_mb: 128,
            max_body_bytes: 1024 * 1024,
            max_concurrent_requests: 64,
            env: BTreeMap::new(),
            directories: vec![],
            outbound_origins: vec![],
            durable: BTreeMap::new(),
        }
    }
}

impl RuntimeConfig {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.timeout_ms > 0 && self.timeout_ms <= 86_400_000,
            "timeout_ms must be 1..86400000"
        );
        ensure!(
            self.memory_mb > 0 && self.memory_mb <= 65536,
            "memory_mb must be 1..65536"
        );
        ensure!(self.max_body_bytes > 0, "max_body_bytes must be positive");
        ensure!(
            (1..=65536).contains(&self.max_concurrent_requests),
            "max_concurrent_requests must be 1..65536"
        );
        for origin in &self.outbound_origins {
            let url = reqwest::Url::parse(origin)?;
            ensure!(
                matches!(url.scheme(), "http" | "https")
                    && url.host_str().is_some()
                    && url.username().is_empty()
                    && url.password().is_none()
                    && url.path() == "/"
                    && url.query().is_none()
                    && url.fragment().is_none(),
                "outbound_origins must contain HTTP(S) origins without paths or credentials"
            );
        }
        Ok(())
    }
}
