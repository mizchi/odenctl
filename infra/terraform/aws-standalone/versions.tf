terraform {
  required_version = ">= 1.6.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.100"
    }
  }
}
provider "aws" {
  region              = var.region
  allowed_account_ids = [var.aws_account_id]
}
