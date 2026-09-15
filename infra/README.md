# Deployment infrastructure

Run repository tasks from the checkout root. Deployment definitions live here;
application code lives in `crates/` and guest examples in `examples/`.

| Directory | Contents |
| --- | --- |
| [docker](docker) | Images for oden, odenctl, and the OpenTelemetry Collector |
| [fly](fly) | Fly control-plane, runtime gateway, and Collector configurations |
| [cloudflare/containers-control](cloudflare/containers-control) | Cloudflare Containers prototype with its own pnpm dependencies |
| [otelcol](otelcol) | Collector configuration and Prometheus alert rules |
| [terraform](terraform) | AWS/GCP deployment definitions and reusable modules |
| [aws-image](aws-image) | Standalone service and manifest bundled in the AWS sample image |

All Dockerfiles use the **repository root** as their build context:

```sh
docker build -f infra/docker/odenctl.Dockerfile -t odenctl:local .
docker build -f infra/docker/oden.Dockerfile -t oden:local .
docker build -f infra/docker/otelcol.Dockerfile -t oden-otelcol:local .
```

Fly recipes pass the root context explicitly. The Cloudflare configuration sets
`image_build_context` to the same root, relative to its Wrangler configuration.
The odenctl image keeps its entry points at `/app/src/main.ts` and
`/app/src/runtime/main.ts`.

See [operations](../docs/user/operations.md), the
[standalone AWS guide](terraform/aws-standalone/README.md), and
[platform implementation notes](../docs/developer/control-plane-reference.md).
