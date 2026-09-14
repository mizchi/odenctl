use oden_service_sdk::{HttpHandler, Lifecycle, telemetry, types};
mod api {
    oden_service_sdk::wasip3::wit_bindgen::generate!({path:"../wit", world:"app", generate_all, with:{"oden:telemetry/tracing@0.1.0":oden_service_sdk::telemetry}});
}
struct App;
oden_service_sdk::export!(App);
impl Lifecycle for App {
    async fn start() -> Result<(), String> {
        Ok(())
    }
    async fn stop() -> Result<(), String> {
        Ok(())
    }
}
impl HttpHandler for App {
    async fn handle(request: types::Request) -> Result<types::Response, types::ErrorCode> {
        use api::example::boundary::operations::{self, Detail, Mode, Payload};
        let context = telemetry::from_request(&request).unwrap();
        let value = if request.get_path_with_query().as_deref() == Some("/error") {
            0
        } else {
            41
        };
        let input = operations::echo(&Payload {
            label: "roundtrip 日本語 🦀".into(),
            value,
            modes: vec![Mode::Steady, Mode::Burst],
            detail: Some(Detail::Numbers(vec![1, 2, 3])),
            pair: (7, "tuple".into()),
        });
        assert!(matches!(
            input.modes.as_slice(),
            [Mode::Steady, Mode::Burst]
        ));
        assert!(matches!(&input.detail, Some(Detail::Numbers(v)) if v == &[1, 2, 3]));
        assert_eq!(input.pair, (7, "tuple".into()));
        let body = match operations::work(context, input).await {
            Ok(p) => {
                assert!(matches!(p.modes.as_slice(), [Mode::Steady, Mode::Burst]));
                assert!(matches!(&p.detail, Some(Detail::Numbers(v)) if v == &[1, 2, 3]));
                assert_eq!(p.pair, (7, "tuple".into()));
                format!("{{\"value\":{},\"label\":\"{}\"}}", p.value, p.label)
            }
            Err(message) => {
                assert_eq!(message, "zero is rejected");
                "{\"error\":true,\"message\":\"zero is rejected\"}".into()
            }
        };
        Ok(oden_service_sdk::json(body))
    }
}
