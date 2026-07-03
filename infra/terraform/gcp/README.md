# wasmplane GCP Terraform POC

This scaffold maps wasmplane onto Cloud Run:

- control plane: Cloud Run service
- runtime: Cloud Run service
- artifacts: Cloud Storage bucket used through an S3-compatible endpoint
- secrets: Secret Manager secret ids injected into Cloud Run

Cloud Run does not expose stable per-instance addresses, so this POC wires a single runtime service
URL into `WASMPLANE_RUNTIME_NODES`. Use GKE when you need the same direct runtime-node publication,
warmup, and drain semantics as Fly Machines. Set `control_plane_url` to a custom domain or run a
second apply after the control service URL is known if runtime heartbeat registration is required.
Set `runtime_public_url` the same way if the runtime should advertise itself through heartbeats.

```sh
terraform -chdir=infra/terraform/gcp init
terraform -chdir=infra/terraform/gcp plan \
  -var='project_id=my-gcp-project' \
  -var='control_image=asia-northeast1-docker.pkg.dev/my-gcp-project/wasmplane/wasmplane:sha' \
  -var='runtime_image=asia-northeast1-docker.pkg.dev/my-gcp-project/wasmplane/wasmplane:sha' \
  -var='database_url_secret_id=wasmplane-database-url' \
  -var='api_token_secret_id=wasmplane-api-token' \
  -var='runtime_token_secret_id=wasmplane-runtime-token' \
  -var='artifact_access_key_id_secret_id=wasmplane-artifact-access-key-id' \
  -var='artifact_secret_access_key_secret_id=wasmplane-artifact-secret-access-key'
```

Production follow-ups:

- validate Cloud Storage XML API / HMAC behavior with the existing SigV4 artifact store
- add a native GCS artifact store if the interoperability path is too fragile
- replace public invoker permissions with HTTPS LB + IAP or authenticated Cloud Run invocation
- add Cloud SQL connector guidance and private egress
- add GKE/EKS manifests for high-fidelity runtime-node management
