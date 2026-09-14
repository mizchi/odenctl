use anyhow::{Context, Result, bail};
use std::{fs, path::Path};
mod assets {
    include!(concat!(env!("OUT_DIR"), "/sdk_assets.rs"));
}

pub fn init(directory: &Path, language: &str) -> Result<()> {
    let assets = match language {
        "rust" => assets::RUST,
        "moonbit" => assets::MOONBIT,
        _ => bail!("unsupported language {language}; expected rust or moonbit"),
    };
    // Reserve a new directory exclusively. Existing files are never overwritten.
    fs::create_dir(directory).context("init requires a new project directory")?;
    let result = (|| {
        for (name, bytes) in assets {
            let path = directory.join(name);
            fs::create_dir_all(path.parent().unwrap())?;
            fs::write(path, bytes)?;
        }
        fs::write(
            directory.join("README.md"),
            format!(
                "# Wasm service ({language})\n\nRun `oden dev app.json`, then open http://127.0.0.1:8080.\n\nThe vendored SDK and WIT are self-contained; commit them along with your source.\nRust requires the wasm32-wasip2 target. MoonBit requires Node.js 24+, MoonBit,\nwit-bindgen 0.62.0 and wasm-tools 1.259.0 on PATH.\n"
            ),
        )?;
        Ok::<_, anyhow::Error>(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(directory);
    }
    result?;
    println!(
        "created {} ({language}); run oden dev {}/app.json",
        directory.display(),
        directory.display()
    );
    Ok(())
}
