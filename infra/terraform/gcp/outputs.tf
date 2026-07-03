output "artifact_bucket" {
  description = "Cloud Storage bucket used through the S3-compatible XML endpoint."
  value       = google_storage_bucket.artifacts.name
}

output "control_url" {
  description = "Cloud Run control-plane URL."
  value       = google_cloud_run_v2_service.control.uri
}

output "runtime_url" {
  description = "Cloud Run runtime URL."
  value       = google_cloud_run_v2_service.runtime.uri
}
