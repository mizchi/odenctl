pub struct Page {
    pub status: u16,
    pub headers: Vec<(&'static str, String)>,
    pub body: Vec<u8>,
}

const VERSION: &str = if cfg!(feature = "release-v2") {
    "v2"
} else {
    "v1"
};
const HTML_CACHE: &str = "public, max-age=0, s-maxage=30, must-revalidate";
const ASSET_CACHE: &str = "public, max-age=31536000, immutable";

pub fn respond(method: &str, path: &str) -> Page {
    let path = path.split('?').next().unwrap_or("/");
    let mut page = if !matches!(method, "GET" | "HEAD") {
        let mut page = page(
            405,
            "text/plain; charset=utf-8",
            "no-store",
            b"Method not allowed\n".to_vec(),
        );
        page.headers.push(("allow", "GET, HEAD".into()));
        page
    } else {
        // Exact embedded paths only: no filesystem or URL-to-file translation.
        match path {
            "/" | "/index.html" => html(include_str!("../site/index.html")),
            "/guide/" | "/guide/index.html" => html(include_str!("../site/guide.html")),
            "/guide" => {
                let mut page = page(308, "text/plain; charset=utf-8", "no-store", vec![]);
                page.headers.push(("location", "/guide/".into()));
                page
            }
            "/assets/v1/site.css" => asset(
                "text/css; charset=utf-8",
                include_bytes!("../site/assets/v1/site.css"),
            ),
            "/assets/v2/site.css" => asset(
                "text/css; charset=utf-8",
                include_bytes!("../site/assets/v2/site.css"),
            ),
            "/assets/v1/site.js" => asset(
                "text/javascript; charset=utf-8",
                include_bytes!("../site/assets/v1/site.js"),
            ),
            "/assets/v2/site.js" => asset(
                "text/javascript; charset=utf-8",
                include_bytes!("../site/assets/v2/site.js"),
            ),
            "/assets/mark.png" => asset("image/png", include_bytes!("../site/assets/mark.png")),
            _ => page(
                404,
                "text/plain; charset=utf-8",
                "no-store",
                b"Not found\n".to_vec(),
            ),
        }
    };
    if method == "HEAD" {
        page.body.clear();
    }
    page
}

fn html(template: &str) -> Page {
    page(
        200,
        "text/html; charset=utf-8",
        HTML_CACHE,
        template.replace("@VERSION@", VERSION).into_bytes(),
    )
}

fn asset(mime: &str, bytes: &[u8]) -> Page {
    page(200, mime, ASSET_CACHE, bytes.to_vec())
}

fn page(status: u16, mime: &str, cache: &str, body: Vec<u8>) -> Page {
    Page {
        status,
        headers: vec![
            ("content-type", mime.into()),
            ("cache-control", cache.into()),
            ("content-length", body.len().to_string()),
            ("x-content-type-options", "nosniff".into()),
        ],
        body,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serves_documents_and_versioned_assets() {
        assert_eq!(respond("GET", "/").status, 200);
        assert_eq!(respond("GET", "/guide/").status, 200);
        for path in [
            "/assets/v1/site.css",
            "/assets/v2/site.css",
            "/assets/v1/site.js",
            "/assets/v2/site.js",
            "/assets/mark.png",
        ] {
            let page = respond("GET", path);
            assert_eq!(page.status, 200, "{path}");
            assert!(!page.body.is_empty());
        }
    }

    #[test]
    fn head_keeps_representation_headers_and_query_does_not_change_content() {
        let get = respond("GET", "/");
        let head = respond("HEAD", "/?utm_source=test");
        assert_eq!(head.status, 200);
        assert!(head.body.is_empty());
        assert_eq!(head.headers, get.headers);
        assert_eq!(respond("GET", "/?v=2").body, get.body);
    }

    #[test]
    fn redirects_directories_and_rejects_unknown_paths_and_methods() {
        let redirect = respond("GET", "/guide");
        assert_eq!(redirect.status, 308);
        assert!(
            redirect
                .headers
                .contains(&("location", "/guide/".to_string()))
        );
        for path in [
            "/.env",
            "/../Cargo.toml",
            "/assets/%2e%2e%2fCargo.toml",
            "/missing",
        ] {
            let page = respond("GET", path);
            assert_eq!(page.status, 404);
            assert!(
                page.headers
                    .contains(&("cache-control", "no-store".to_string()))
            );
        }
        assert_eq!(respond("POST", "/").status, 405);
    }
}
