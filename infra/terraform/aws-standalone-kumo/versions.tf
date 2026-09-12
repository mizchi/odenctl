terraform {
  required_version = ">= 1.6.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.100"
    }
  }
}
variable "kumo_endpoint" {
  type    = string
  default = "http://127.0.0.1:4566"
  validation {
    condition     = can(regex("^http://127\\.0\\.0\\.1:[0-9]+$", var.kumo_endpoint))
    error_message = "This test root only accepts a loopback kumo endpoint."
  }
}
provider "aws" {
  region                      = "ap-northeast-1"
  access_key                  = "test"
  secret_key                  = "test"
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true
  skip_region_validation      = true
  max_retries                 = 1
  endpoints {
    ec2            = var.kumo_endpoint
    ecr            = var.kumo_endpoint
    ecs            = var.kumo_endpoint
    elbv2          = var.kumo_endpoint
    iam            = var.kumo_endpoint
    cloudwatchlogs = var.kumo_endpoint
    sts            = var.kumo_endpoint
  }
}
