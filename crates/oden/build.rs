use std::{env, fs, path::Path};

fn bundle(source: &Path, prefix: &str, output: &mut String) {
    println!("cargo:rerun-if-changed={}", source.display());
    let mut entries: Vec<_> = fs::read_dir(source)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    entries.sort();
    for path in entries {
        let name = path.file_name().unwrap().to_str().unwrap();
        if matches!(
            name,
            "target" | "Cargo.lock" | "node_modules" | "package-lock.json"
        ) {
            continue;
        }
        let destination = format!("{prefix}{name}");
        if path.is_dir() {
            bundle(&path, &format!("{destination}/"), output);
        } else {
            println!("cargo:rerun-if-changed={}", path.display());
            output.push_str(&format!(
                "({destination:?}, include_bytes!({:?})),\n",
                path.canonicalize().unwrap()
            ));
        }
    }
}
fn main() {
    let mut generated = String::new();
    for (name, sdk, template) in [
        ("RUST", "../../sdk/rust", "templates/rust"),
        ("MOONBIT", "../../sdk/moonbit", "templates/moonbit"),
    ] {
        generated.push_str(&format!("pub const {name}: &[(&str, &[u8])] = &[\n"));
        bundle(Path::new(sdk), "vendor/oden-sdk/", &mut generated);
        bundle(Path::new(template), "", &mut generated);
        if name == "MOONBIT" {
            bundle(
                Path::new("../../wit/app"),
                "vendor/oden-sdk/wit/app/",
                &mut generated,
            );
        }
        generated.push_str("];\n");
    }
    fs::write(
        Path::new(&env::var_os("OUT_DIR").unwrap()).join("sdk_assets.rs"),
        generated,
    )
    .unwrap();
}
