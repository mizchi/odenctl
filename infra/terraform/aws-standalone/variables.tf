variable "aws_account_id" {
  description = "Expected AWS account. The provider refuses credentials for another account."
  type        = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "Provide a 12-digit AWS account ID."
  }
}
variable "region" {
  type    = string
  default = "ap-northeast-1"
}
variable "name" {
  type    = string
  default = "wasmplane"
}
variable "certificate_arn" {
  description = "Issued ACM certificate in this region, covering the application DNS name."
  type        = string
}
variable "image" {
  description = "Container image URI pinned by digest. Null is for initial ECR bootstrap with desired_count=0."
  type        = string
  default     = null
  validation {
    condition     = var.image == null ? true : can(regex("@sha256:[0-9a-f]{64}$", var.image))
    error_message = "Pin a deployed image by its sha256 digest."
  }
}
variable "desired_count" {
  type    = number
  default = 0
}
variable "cpu_architecture" {
  type    = string
  default = "ARM64"
}
variable "availability_zones" {
  type    = list(string)
  default = null
}
variable "health_check_path" {
  type    = string
  default = "/healthz"
}
variable "tags" {
  type    = map(string)
  default = {}
}
