module "runtime" {
  source             = "../modules/standalone-ecs"
  name               = var.name
  region             = var.region
  availability_zones = var.availability_zones
  image              = var.image
  certificate_arn    = var.certificate_arn
  desired_count      = var.desired_count
  cpu_architecture   = var.cpu_architecture
  health_check_path  = var.health_check_path
  tags               = var.tags
}
# A failed precondition stops a plan before any AWS changes can be applied.
resource "terraform_data" "deployment_contract" {
  lifecycle {
    precondition {
      condition     = var.desired_count == 0 || var.image != null
      error_message = "Set a digest-pinned image before starting ECS tasks."
    }
    precondition {
      condition     = startswith(var.certificate_arn, "arn:aws:acm:${var.region}:${var.aws_account_id}:certificate/")
      error_message = "The ACM certificate must belong to the configured AWS account and region."
    }
  }
}
output "alb_dns_name" { value = module.runtime.alb_dns_name }
output "alb_zone_id" { value = module.runtime.alb_zone_id }
output "repository_url" { value = module.runtime.repository_url }
output "cluster_name" { value = module.runtime.cluster_name }
output "service_name" { value = module.runtime.service_name }
output "task_definition_arn" { value = module.runtime.task_definition_arn }
output "log_group_name" { value = module.runtime.log_group_name }
