output "alb_dns_name" {
  description = "ALB DNS name. Point control_host and runtime_host at this name."
  value       = aws_lb.this.dns_name
}

output "artifact_bucket" {
  description = "S3 bucket for wasmplane artifacts."
  value       = aws_s3_bucket.artifacts.bucket
}

output "control_url" {
  description = "Expected control-plane URL after DNS is configured."
  value       = "https://${var.control_host}"
}

output "runtime_url" {
  description = "Expected runtime URL after DNS is configured."
  value       = "https://${var.runtime_host}"
}
