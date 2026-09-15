use sha2::{Digest, Sha256};
use std::path::Path;

fn hash_tree(path: &Path, hash: &mut Sha256) {
    println!("cargo:rerun-if-changed={}", path.display());
    if path.is_dir() {
        let mut entries: Vec<_> = std::fs::read_dir(path)
            .unwrap()
            .map(|e| e.unwrap().path())
            .collect();
        entries.sort();
        for entry in entries {
            hash_tree(&entry, hash);
        }
    } else if path.is_file() {
        hash.update(path.file_name().unwrap().as_encoded_bytes());
        hash.update(std::fs::read(path).unwrap());
    }
}

fn main() {
    let mut hash = Sha256::new();
    for path in [
        "src",
        "build.rs",
        "Cargo.toml",
        "../../wit",
        "../../Cargo.lock",
    ] {
        hash_tree(Path::new(path), &mut hash);
    }
    let target = std::env::var("TARGET").unwrap();
    hash.update(&target);
    hash.update(std::env::var("PROFILE").unwrap());
    for name in ["CARGO_CFG_TARGET_FEATURE", "CARGO_ENCODED_RUSTFLAGS"] {
        println!("cargo:rerun-if-env-changed={name}");
        hash.update(std::env::var(name).unwrap_or_default());
    }
    let rustc = std::process::Command::new(std::env::var_os("RUSTC").unwrap())
        .arg("-vV")
        .output()
        .expect("read compiler version");
    assert!(rustc.status.success());
    hash.update(rustc.stdout);
    println!(
        "cargo:rustc-env=ODEN_ENGINE_BUILD={:x}",
        hash.finalize()
    );
    println!("cargo:rustc-env=ODEN_ENGINE_TARGET={target}");
}
