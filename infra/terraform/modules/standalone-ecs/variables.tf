variable "name" {
  type    = string
  default = "wasmplane"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,23}$", var.name)) && !endswith(var.name, "-")
    error_message = "Use 1–24 lowercase letters, digits, or hyphens, starting with a letter and not ending with a hyphen."
  }
}
variable "region" {
  type    = string
  default = "ap-northeast-1"
}
variable "availability_zones" {
  description = "Two distinct AZ names. Defaults to region a/c; override outside Tokyo."
  type        = list(string)
  default     = null
  validation {
    condition     = var.availability_zones == null ? true : length(var.availability_zones) == 2 && length(distinct(var.availability_zones)) == 2
    error_message = "Specify exactly two distinct availability zones."
  }
}
variable "image" {
  description = "Image URI, preferably pinned by digest. Null uses the managed ECR repository's initial tag."
  type        = string
  default     = null
}
variable "certificate_arn" {
  description = "ARN of an issued ACM certificate in the ALB region."
  type        = string
  validation {
    condition     = can(regex("^arn:aws:acm:[a-z0-9-]+:[0-9]{12}:certificate/.+$", var.certificate_arn))
    error_message = "An ACM certificate ARN is required for the HTTPS listener."
  }
}
variable "desired_count" {
  description = "Independent application replicas; resident state is local to each task. Use 0 when bootstrapping ECR."
  type        = number
  default     = 1
  validation {
    condition     = var.desired_count >= 0 && var.desired_count <= 100 && floor(var.desired_count) == var.desired_count
    error_message = "desired_count must be an integer from 0 through 100."
  }
}
variable "cpu_architecture" {
  type    = string
  default = "ARM64"
  validation {
    condition     = contains(["ARM64", "X86_64"], var.cpu_architecture)
    error_message = "Use ARM64 or X86_64 and build the container image for that architecture."
  }
}
variable "health_check_path" {
  description = "Side-effect-free guest route returning HTTP 200 after the service is ready."
  type        = string
  default     = "/healthz"
  validation {
    condition     = startswith(var.health_check_path, "/")
    error_message = "The health check path must start with /."
  }
}
variable "tags" {
  type    = map(string)
  default = {}
}
