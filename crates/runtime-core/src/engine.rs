use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use wasmtime::{Config, Engine, ModuleVersionStrategy};

pub const VERSION: &str = "48.0.2";
pub const BUILD: &str = env!("ODEN_ENGINE_BUILD");
pub const TARGET: &str = env!("ODEN_ENGINE_TARGET");
pub const EPOCH_MS: u64 = 5;

pub(crate) fn configure(config: &mut Config) {
    // Wasmtime checks this before loading native code from a local cache.
    config
        .module_version(ModuleVersionStrategy::Custom(BUILD.to_owned()))
        .unwrap();
}

pub(crate) struct EpochTicker {
    stopped: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl EpochTicker {
    pub fn new(engine: Engine) -> Self {
        let stopped = Arc::new(AtomicBool::new(false));
        let stop = stopped.clone();
        let thread = thread::spawn(move || {
            while !stop.load(Ordering::Acquire) {
                thread::park_timeout(Duration::from_millis(EPOCH_MS));
                engine.increment_epoch();
            }
        });
        Self {
            stopped,
            thread: Some(thread),
        }
    }
}

impl Drop for EpochTicker {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            thread.thread().unpark();
            let _ = thread.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wasmtime::component::Component;

    #[test]
    fn incompatible_build_cannot_load_precompiled_component() {
        let mut config = Config::new();
        configure(&mut config);
        let engine = Engine::new(&config).unwrap();
        let bytes = Component::new(&engine, "(component)")
            .unwrap()
            .serialize()
            .unwrap();
        let mut other = Config::new();
        other
            .module_version(ModuleVersionStrategy::Custom("another-build".into()))
            .unwrap();
        let other = Engine::new(&other).unwrap();
        // The bytes above were produced locally by a trusted compiler.
        assert!(unsafe { Component::deserialize(&other, &bytes) }.is_err());
        assert!(unsafe { Component::deserialize(&engine, &bytes) }.is_ok());
    }
}
