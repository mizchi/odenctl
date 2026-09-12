use wasmplane_service_sdk::{telemetry, wasip3};
wasip3::wit_bindgen::generate!({path:"../wit", world:"provider", generate_all, with:{"wasmplane:telemetry/tracing@0.1.0":wasmplane_service_sdk::telemetry}});
use exports::example::boundary::operations::{Context, Guest, Payload};
struct Provider;
export!(Provider);
impl Guest for Provider {
    async fn work(context: Context, input: Payload) -> Result<Payload, String> {
        wasmplane_service_sdk::sleep_ms(5).await;
        telemetry::log(
            Some(&context),
            telemetry::Level::Info,
            "composed.provider",
            &[],
        );
        if input.value == 0 {
            return Err("zero is rejected".into());
        }
        Ok(Payload {
            value: input.value + 1,
            ..input
        })
    }
    fn echo(input: Payload) -> Payload {
        input
    }
}
