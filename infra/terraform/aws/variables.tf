variable "name" {
  description = "Name prefix for odenctl AWS resources."
  type        = string
  default     = "odenctl"
}

variable "region" {
  description = "AWS region."
  type        = string
  default     = "ap-northeast-1"
}

variable "vpc_id" {
  description = "VPC id that contains the public and private subnets."
  type        = string
}

variable "public_subnet_ids" {
  description = "Public subnet ids for the ALB."
  type        = list(string)
}

variable "private_subnet_ids" {
  description = "Private subnet ids for ECS tasks."
  type        = list(string)
}

variable "control_host" {
  description = "Host header routed to the control-plane service."
  type        = string
}

variable "runtime_host" {
  description = "Host header routed to the runtime service."
  type        = string
}

variable "control_image" {
  description = "Container image for the control-plane process."
  type        = string
}

variable "runtime_image" {
  description = "Container image for the runtime process."
  type        = string
}

variable "artifact_bucket_name" {
  description = "Optional S3 bucket name. Leave empty to let AWS generate a name."
  type        = string
  default     = ""
}

variable "database_url_secret_arn" {
  description = "Secrets Manager secret ARN containing DATABASE_URL."
  type        = string
}

variable "api_token_secret_arn" {
  description = "Secrets Manager secret ARN containing ODENCTL_API_TOKEN."
  type        = string
}

variable "runtime_token_secret_arn" {
  description = "Secrets Manager secret ARN containing ODEN_RUNTIME_TOKEN."
  type        = string
}

variable "artifact_access_key_id_secret_arn" {
  description = "Secrets Manager secret ARN containing ODENCTL_ARTIFACT_ACCESS_KEY_ID."
  type        = string
}

variable "artifact_secret_access_key_secret_arn" {
  description = "Secrets Manager secret ARN containing ODENCTL_ARTIFACT_SECRET_ACCESS_KEY."
  type        = string
}

variable "control_desired_count" {
  description = "Desired control-plane ECS task count."
  type        = number
  default     = 1
}

variable "runtime_desired_count" {
  description = "Desired runtime ECS task count."
  type        = number
  default     = 2
}

variable "tags" {
  description = "Additional tags."
  type        = map(string)
  default     = {}
}
