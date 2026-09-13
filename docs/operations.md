# First service deployment

Start with one application whose persistent state is external to the runtime.
The standalone ECS/Fargate configuration provides HTTPS, image digest pinning,
CloudWatch stdout/stderr logs and rolling deployments. The runtime provides
request limits, graceful service shutdown and OTLP telemetry. Deployment targets,
application permissions and the telemetry destination are operator choices.

## Prepare the release

Build and exercise the deployment sample before substituting an application:

```sh
just aws-image-test
just aws-image-build wasmplane-service:candidate linux/arm64
just aws-container-test wasmplane-service:candidate
just aws-standalone-validate
```

The sample has `/healthz`, service metadata at `/`, and no fault-injection routes.
The container test runs two start/stop cycles as UID 65532, with a read-only root
filesystem, dropped capabilities, 0.5 CPU and 1 GiB of memory. It verifies health
checks, HTTP status behavior and exit code 0 after SIGTERM. CI runs the same image
test on Linux AMD64; the default Fargate configuration uses ARM64.

These tests validate the bootstrap sample. For an actual Rust or MoonBit component,
replace `/app/service.wasm` and `/app/app.json` in a derived image and run the
application's own HTTP and persistence tests. Retain a side-effect-free health
route that exercises the guest. A TCP connection alone does not establish that a
resident generation can execute requests.

Record the source revision, final image digest, component hash, application
manifest and test results for each release. Deploy the same digest that was tested.

## Configure the first environment

Use the [AWS deployment procedure](../infra/terraform/aws-standalone/README.md).
It requires the selected AWS profile/account, region, issued ACM certificate and
public DNS name. Start with `desired_count = 0` to create ECR and infrastructure,
push the candidate image, then plan the digest-pinned application deployment.
The initial service can run one task; use at least two independent tasks if the
application's availability requirements include an individual task failure.

Choose a remote state backend before operating the environment from multiple
machines or CI. An S3 backend needs a separately provisioned bucket, access policy
and locking configuration; see the [OpenTofu S3 backend](https://opentofu.org/docs/language/settings/backends/s3/).
The repository uses local state until that backend is configured. Keep state and
credentials outside Git.

The sample has no durable storage. Resident memory is local to a task and is lost
on replacement. Set up the application's database or celld persistence, backup
and restore process before depending on retained data. Runtime support for the
celld gateway does not provision or operate a celld fleet.

## Connect observability

Select an OTLP/HTTP endpoint with retained traces, metrics and logs, and configure
it through `runtime.telemetry` in the baked application manifest. The runtime also
accepts host OTEL environment variables; ECS environment values must be explicitly
added to the task definition. The current Terraform module does not provision an
OTLP collector or automatically configure these variables.

Verify that a request with a known `traceparent` appears in the collector, that
unsampled requests still contribute to metrics, and that a failed collector does
not prevent HTTP responses. See [built-in telemetry](telemetry.md) for the exact
transport, sampling behavior and queue limits.

Set alerts for unhealthy ALB targets, failed ECS deployments, application errors
and latency, task memory pressure and dropped telemetry. Select thresholds from
the application's traffic and latency requirements. CloudWatch stdout/stderr
logging alone does not retain the runtime's OTLP signals.

## Accept, update and recover

After an apply, verify the requested image digest, ECS rollout state, healthy ALB
targets, HTTPS response through the public name and telemetry receipt. Exercise a
replacement task and a rollback in the first environment before relying on the
procedure for incident recovery.

ECS circuit-breaker rollback needs a previously completed deployment. The first
deployment has no successful revision to restore; a failed initial rollout needs
operator action. See the [ECS circuit breaker](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/deployment-circuit-breaker.html).

For an update, retain the previous ECR digest, deploy a new digest with a reviewed
Terraform plan, and repeat the acceptance checks. Restore the previous digest to
roll back application code. Database and durable-object schema changes need their
own compatibility and rollback strategy.

The runtime's 10-second service shutdown budget fits inside the task's 30-second
stop timeout and ALB deregistration delay. Keep these budgets aligned when
changing application behavior. Forced termination can lose unfinished work and
queued telemetry; graceful shutdown is part of release verification.
