run "deployment_contract" {
  command = plan

  assert {
    condition     = jsondecode(module.runtime.container_definitions)[0].entryPoint == ["/usr/local/bin/wasmplane"]
    error_message = "The task must run the standalone runtime directly so ECS signals reach it."
  }
  assert {
    condition     = jsondecode(module.runtime.container_definitions)[0].command == ["start", "/app/app.json"]
    error_message = "The packaged manifest must own guest mode, permissions, and lifecycle deadlines."
  }
  assert {
    condition     = jsondecode(module.runtime.container_definitions)[0].readonlyRootFilesystem
    error_message = "The default application image must run with a read-only root filesystem."
  }
  assert {
    condition     = module.runtime.listener_protocol == "HTTPS" && module.runtime.http_action == "redirect"
    error_message = "Only HTTPS may forward public application traffic."
  }
  assert {
    condition     = module.runtime.stop_timeout_seconds > 10 && module.runtime.deregistration_delay_seconds >= 30
    error_message = "The container and ALB must leave time for the default 10-second guest shutdown."
  }
  assert {
    condition     = module.runtime.health_check_path == "/healthz"
    error_message = "The deployment sample must use its side-effect-free readiness route."
  }
}
