import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("multi-cloud infra roadmap covers AWS, GCP, and Cloudflare Containers", async () => {
  const todo = await readFile("TODO.md", "utf8");
  const readme = await readFile("README.md", "utf8");
  const justfile = await readFile("justfile", "utf8");
  const workflow = await readFile(".github/workflows/ci.yml", "utf8");

  assert.match(todo, /## 37\. Multi-cloud infrastructure/);
  assert.match(todo, /AWS ECS\/Fargate/);
  assert.match(todo, /GCP Cloud Run/);
  assert.match(todo, /Cloudflare Containers control-plane POC/);
  assert.match(readme, /## Multi-cloud Deploy POC/);
  assert.match(justfile, /^tofu-fmt-check:/m);
  assert.match(justfile, /^tofu-validate:/m);
  assert.match(await readFile("infra/terraform/aws/.terraform.lock.hcl", "utf8"), /registry\.opentofu\.org\/hashicorp\/aws/);
  assert.match(await readFile("infra/terraform/gcp/.terraform.lock.hcl", "utf8"), /registry\.opentofu\.org\/hashicorp\/google/);
  assert.match(workflow, /opentofu\/setup-opentofu/);
  assert.match(workflow, /just tofu-fmt-check/);
  assert.match(workflow, /just tofu-validate/);
});

test("AWS Terraform scaffold defines ECS control and runtime services", async () => {
  const main = await readFile("infra/terraform/aws/main.tf", "utf8");
  const variables = await readFile("infra/terraform/aws/variables.tf", "utf8");
  const readme = await readFile("infra/terraform/aws/README.md", "utf8");

  assert.match(main, /resource "aws_ecs_cluster" "this"/);
  assert.match(main, /resource "aws_ecs_service" "control"/);
  assert.match(main, /resource "aws_ecs_service" "runtime"/);
  assert.match(main, /resource "aws_s3_bucket" "artifacts"/);
  assert.match(main, /WASMPLANE_WASIP3_HOST_DAEMON/);
  assert.match(variables, /database_url_secret_arn/);
  assert.match(variables, /artifact_access_key_id_secret_arn/);
  assert.match(readme, /ECS\/Fargate/);
});

test("GCP Terraform scaffold defines Cloud Run control and runtime services", async () => {
  const main = await readFile("infra/terraform/gcp/main.tf", "utf8");
  const variables = await readFile("infra/terraform/gcp/variables.tf", "utf8");
  const readme = await readFile("infra/terraform/gcp/README.md", "utf8");

  assert.match(main, /resource "google_cloud_run_v2_service" "control"/);
  assert.match(main, /resource "google_cloud_run_v2_service" "runtime"/);
  assert.match(main, /resource "google_storage_bucket" "artifacts"/);
  assert.match(main, /WASMPLANE_RUNTIME_NODES/);
  assert.match(variables, /database_url_secret_id/);
  assert.match(variables, /artifact_access_key_id_secret_id/);
  assert.match(readme, /Cloud Run/);
});

test("Cloudflare Containers control-plane POC routes Worker requests to the container", async () => {
  const config = await readFile("cloudflare/containers-control/wrangler.jsonc", "utf8");
  const worker = await readFile("cloudflare/containers-control/src/index.ts", "utf8");
  const readme = await readFile("cloudflare/containers-control/README.md", "utf8");

  assert.match(config, /"containers"/);
  assert.match(config, /"class_name": "WasmplaneControlContainer"/);
  assert.match(config, /"image": "..\/..\/Dockerfile"/);
  assert.match(config, /"new_sqlite_classes": \["WasmplaneControlContainer"\]/);
  assert.match(worker, /extends Container/);
  assert.match(worker, /getContainer\(env\.CONTROL_CONTAINER/);
  assert.match(worker, /containerFetch\(request\)/);
  assert.match(readme, /wrangler deploy/);
});

test("Cloudflare backend decision is recorded as an ADR", async () => {
  const design = await readFile("DESIGN.md", "utf8");

  assert.match(design, /## ADR: Cloudflare Backend Strategy/);
  assert.match(design, /control plane POC uses Cloudflare Containers/);
  assert.match(design, /production Wasmtime runtime stays on container-capable infrastructure/);
  assert.match(design, /native Cloudflare backend is a separate target/);
});
