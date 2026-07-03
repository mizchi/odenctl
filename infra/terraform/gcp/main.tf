locals {
  labels = merge(var.labels, {
    app = var.name
  })

  artifact_bucket = var.artifact_bucket_name == "" ? "${var.project_id}-${var.name}-artifacts" : var.artifact_bucket_name
}

resource "google_service_account" "runtime" {
  account_id   = "${var.name}-runtime"
  display_name = "wasmplane Cloud Run runtime"
}

resource "google_storage_bucket" "artifacts" {
  name                        = local.artifact_bucket
  location                    = var.region
  uniform_bucket_level_access = true
  labels                      = local.labels
}

resource "google_cloud_run_v2_service" "runtime" {
  name     = "${var.name}-runtime"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"
  labels   = local.labels

  template {
    service_account = google_service_account.runtime.email

    scaling {
      min_instance_count = 1
      max_instance_count = 10
    }

    containers {
      image = var.runtime_image
      command = ["node", "--experimental-strip-types", "src/runtime/main.ts"]

      ports {
        container_port = 8080
      }

      env {
        name  = "RUNTIME_HOST"
        value = "0.0.0.0"
      }
      env {
        name  = "RUNTIME_PORT"
        value = "8080"
      }
      env {
        name  = "RUNTIME_PUBLIC_URL"
        value = var.runtime_public_url
      }
      env {
        name  = "CONTROL_PLANE_URL"
        value = var.control_plane_url
      }
      env {
        name  = "WASMPLANE_CACHE_DIR"
        value = "/tmp/wasmplane/cache"
      }
      env {
        name  = "WASMPLANE_ARTIFACT_CACHE_DIR"
        value = "/tmp/wasmplane/artifacts"
      }
      env {
        name  = "WASMPLANE_KV_STORE_DIR"
        value = "/tmp/wasmplane/kv"
      }
      env {
        name  = "WASMPLANE_WASIP3_HOST_BIN"
        value = "/usr/local/bin/wasmplane-wasip3-host"
      }
      env {
        name  = "WASMPLANE_WASIP3_HOST_DAEMON"
        value = "1"
      }
      env {
        name  = "WASMPLANE_WASIP3_HOST_DAEMON_ROUTES"
        value = "1"
      }
      env {
        name  = "WASMPLANE_WASIP3_HOST_DAEMON_WORKER_PROXY"
        value = "1"
      }
      env {
        name  = "WASMPLANE_CONTROL_PLANE_TOKEN"
        value_source {
          secret_key_ref {
            secret  = var.api_token_secret_id
            version = "latest"
          }
        }
      }
      env {
        name  = "WASMPLANE_RUNTIME_TOKEN"
        value_source {
          secret_key_ref {
            secret  = var.runtime_token_secret_id
            version = "latest"
          }
        }
      }
      env {
        name  = "WASMPLANE_ARTIFACT_ACCESS_KEY_ID"
        value_source {
          secret_key_ref {
            secret  = var.artifact_access_key_id_secret_id
            version = "latest"
          }
        }
      }
      env {
        name  = "WASMPLANE_ARTIFACT_SECRET_ACCESS_KEY"
        value_source {
          secret_key_ref {
            secret  = var.artifact_secret_access_key_secret_id
            version = "latest"
          }
        }
      }
    }
  }
}

resource "google_cloud_run_v2_service" "control" {
  name     = "${var.name}-control"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"
  labels   = local.labels

  template {
    service_account = google_service_account.runtime.email

    scaling {
      min_instance_count = 1
      max_instance_count = 3
    }

    containers {
      image = var.control_image
      command = ["node", "--experimental-strip-types", "src/main.ts"]

      ports {
        container_port = 8080
      }

      env {
        name  = "HOST"
        value = "0.0.0.0"
      }
      env {
        name  = "PORT"
        value = "8080"
      }
      env {
        name  = "WASMPLANE_ARTIFACT_STORE"
        value = "s3"
      }
      env {
        name  = "WASMPLANE_ARTIFACT_BUCKET"
        value = google_storage_bucket.artifacts.name
      }
      env {
        name  = "WASMPLANE_ARTIFACT_ENDPOINT"
        value = "https://storage.googleapis.com"
      }
      env {
        name  = "WASMPLANE_ARTIFACT_REGION"
        value = "auto"
      }
      env {
        name  = "WASMPLANE_RUNTIME_NODES"
        value = google_cloud_run_v2_service.runtime.uri
      }
      env {
        name  = "WASMPLANE_REQUIRE_EXTERNAL_DATABASE"
        value = "1"
      }
      env {
        name  = "WASMPLANE_REQUIRE_EXTERNAL_ARTIFACT_STORE"
        value = "1"
      }
      env {
        name  = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = var.database_url_secret_id
            version = "latest"
          }
        }
      }
      env {
        name  = "WASMPLANE_API_TOKEN"
        value_source {
          secret_key_ref {
            secret  = var.api_token_secret_id
            version = "latest"
          }
        }
      }
      env {
        name  = "WASMPLANE_RUNTIME_TOKEN"
        value_source {
          secret_key_ref {
            secret  = var.runtime_token_secret_id
            version = "latest"
          }
        }
      }
      env {
        name  = "WASMPLANE_ARTIFACT_ACCESS_KEY_ID"
        value_source {
          secret_key_ref {
            secret  = var.artifact_access_key_id_secret_id
            version = "latest"
          }
        }
      }
      env {
        name  = "WASMPLANE_ARTIFACT_SECRET_ACCESS_KEY"
        value_source {
          secret_key_ref {
            secret  = var.artifact_secret_access_key_secret_id
            version = "latest"
          }
        }
      }
    }
  }
}

resource "google_cloud_run_v2_service_iam_member" "control_public" {
  count    = var.allow_unauthenticated ? 1 : 0
  name     = google_cloud_run_v2_service.control.name
  location = google_cloud_run_v2_service.control.location
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_v2_service_iam_member" "runtime_public" {
  count    = var.allow_unauthenticated ? 1 : 0
  name     = google_cloud_run_v2_service.runtime.name
  location = google_cloud_run_v2_service.runtime.location
  role     = "roles/run.invoker"
  member   = "allUsers"
}
