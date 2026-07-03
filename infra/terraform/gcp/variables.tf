variable "project_id" {
  description = "GCP project id."
  type        = string
}

variable "name" {
  description = "Name prefix for wasmplane GCP resources."
  type        = string
  default     = "wasmplane"
}

variable "region" {
  description = "GCP region."
  type        = string
  default     = "asia-northeast1"
}

variable "control_image" {
  description = "Container image for the control-plane process."
  type        = string
}

variable "runtime_image" {
  description = "Container image for the runtime process."
  type        = string
}

variable "control_plane_url" {
  description = "Optional externally stable control-plane URL for runtime heartbeat. Use a custom domain or update after the first apply."
  type        = string
  default     = ""
}

variable "runtime_public_url" {
  description = "Optional externally stable runtime URL advertised by the runtime service. Use a custom domain or update after the first apply."
  type        = string
  default     = ""
}

variable "artifact_bucket_name" {
  description = "Optional Cloud Storage bucket name. Leave empty to derive one from project/name."
  type        = string
  default     = ""
}

variable "database_url_secret_id" {
  description = "Secret Manager secret id containing DATABASE_URL."
  type        = string
}

variable "api_token_secret_id" {
  description = "Secret Manager secret id containing WASMPLANE_API_TOKEN."
  type        = string
}

variable "runtime_token_secret_id" {
  description = "Secret Manager secret id containing WASMPLANE_RUNTIME_TOKEN."
  type        = string
}

variable "artifact_access_key_id_secret_id" {
  description = "Secret Manager secret id containing WASMPLANE_ARTIFACT_ACCESS_KEY_ID for the S3-compatible artifact endpoint."
  type        = string
}

variable "artifact_secret_access_key_secret_id" {
  description = "Secret Manager secret id containing WASMPLANE_ARTIFACT_SECRET_ACCESS_KEY for the S3-compatible artifact endpoint."
  type        = string
}

variable "allow_unauthenticated" {
  description = "Whether to grant public Cloud Run invoke permissions. Disable behind an external HTTPS LB/IAP."
  type        = bool
  default     = true
}

variable "labels" {
  description = "Additional labels."
  type        = map(string)
  default     = {}
}
