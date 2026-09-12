# wasmplane AWS Terraform POC

For the standalone Wasm runtime and local kumo validation, use the
[new ECS deployment guide](../aws-standalone/README.md). This directory contains
the older control-plane/runtime-node scaffold.

This scaffold maps the current Fly split onto AWS:

- control plane: ECS/Fargate service behind an ALB host rule
- runtime: ECS/Fargate service behind an ALB host rule
- artifacts: S3 bucket
- logs: CloudWatch log groups
- secrets: Secrets Manager secret ARNs injected into ECS tasks

It intentionally requires an existing VPC, public subnets, private subnets, and a `DATABASE_URL`
secret. Add an RDS/Aurora module after the network and secret-management choices are fixed.

```sh
terraform -chdir=infra/terraform/aws init
terraform -chdir=infra/terraform/aws plan \
  -var='vpc_id=vpc-...' \
  -var='public_subnet_ids=["subnet-public-a","subnet-public-c"]' \
  -var='private_subnet_ids=["subnet-private-a","subnet-private-c"]' \
  -var='control_host=control.example.com' \
  -var='runtime_host=runtime.example.com' \
  -var='control_image=<account>.dkr.ecr.ap-northeast-1.amazonaws.com/wasmplane:sha' \
  -var='runtime_image=<account>.dkr.ecr.ap-northeast-1.amazonaws.com/wasmplane:sha' \
  -var='database_url_secret_arn=arn:aws:secretsmanager:...' \
  -var='api_token_secret_arn=arn:aws:secretsmanager:...' \
  -var='runtime_token_secret_arn=arn:aws:secretsmanager:...' \
  -var='artifact_access_key_id_secret_arn=arn:aws:secretsmanager:...' \
  -var='artifact_secret_access_key_secret_arn=arn:aws:secretsmanager:...'
```

Production follow-ups:

- add HTTPS listener and ACM certificate wiring
- replace static `WASMPLANE_RUNTIME_NODES` with ECS task discovery or heartbeat registration
- add RDS/Aurora Postgres and backup policy
- add OTEL Collector service and Prometheus/AMP export path
- move artifact credentials to IAM-role based signing in the application
