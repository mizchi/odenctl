output "alb_dns_name" { value = aws_lb.this.dns_name }
output "alb_zone_id" { value = aws_lb.this.zone_id }
output "repository_url" { value = aws_ecr_repository.app.repository_url }
output "cluster_name" { value = aws_ecs_cluster.this.name }
output "service_name" { value = aws_ecs_service.app.name }
output "task_definition_arn" { value = aws_ecs_task_definition.app.arn }
output "log_group_name" { value = aws_cloudwatch_log_group.app.name }
output "container_definitions" {
  description = "Container contract used for deployment inspection and tests. Contains no secrets."
  value       = aws_ecs_task_definition.app.container_definitions
}
output "listener_protocol" { value = aws_lb_listener.https.protocol }
output "http_action" { value = aws_lb_listener.http.default_action[0].type }
output "stop_timeout_seconds" { value = jsondecode(aws_ecs_task_definition.app.container_definitions)[0].stopTimeout }
output "deregistration_delay_seconds" { value = tonumber(aws_lb_target_group.app.deregistration_delay) }
output "health_check_path" { value = aws_lb_target_group.app.health_check[0].path }
