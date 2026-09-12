# Local AWS API validation with kumo

This root calls the same standalone ECS module as the AWS deployment, with dummy
credentials and explicit loopback-only endpoints for every AWS API it uses.
Its state is separate from the AWS root. Use `just aws-kumo-test` to run an owned,
temporary kumo process and keep logs under `reports/aws-kumo/`.

See the [deployment guide](../aws-standalone/README.md#validate-locally-with-kumo)
for setup, tested coverage, and known emulator limitations. In particular, kumo
v0.29.0 cannot complete a full ECS Terraform apply because ECS read APIs are missing.

The fixture's image and certificate ARNs are placeholders for API tests. They are
not deployable application assets or usable TLS certificates.
