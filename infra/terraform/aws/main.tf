locals {
  tags = merge(var.tags, {
    Project = var.name
  })

  control_env = [
    { name = "HOST", value = "0.0.0.0" },
    { name = "PORT", value = "8080" },
    { name = "WASMPLANE_ARTIFACT_STORE", value = "s3" },
    { name = "WASMPLANE_ARTIFACT_BUCKET", value = aws_s3_bucket.artifacts.bucket },
    { name = "WASMPLANE_ARTIFACT_REGION", value = var.region },
    { name = "WASMPLANE_RUNTIME_NODES", value = "https://${var.runtime_host}" },
    { name = "WASMPLANE_REQUIRE_EXTERNAL_DATABASE", value = "1" },
    { name = "WASMPLANE_REQUIRE_EXTERNAL_ARTIFACT_STORE", value = "1" },
    { name = "WASMPLANE_WASIP3_HOST_BIN", value = "/usr/local/bin/wasmplane-wasip3-host" }
  ]

  runtime_env = [
    { name = "RUNTIME_HOST", value = "0.0.0.0" },
    { name = "RUNTIME_PORT", value = "8080" },
    { name = "RUNTIME_PUBLIC_URL", value = "https://${var.runtime_host}" },
    { name = "CONTROL_PLANE_URL", value = "https://${var.control_host}" },
    { name = "WASMPLANE_CACHE_DIR", value = "/tmp/wasmplane/cache" },
    { name = "WASMPLANE_ARTIFACT_CACHE_DIR", value = "/tmp/wasmplane/artifacts" },
    { name = "WASMPLANE_KV_STORE_DIR", value = "/tmp/wasmplane/kv" },
    { name = "WASMPLANE_WASIP3_HOST_BIN", value = "/usr/local/bin/wasmplane-wasip3-host" },
    { name = "WASMPLANE_WASIP3_HOST_DAEMON", value = "1" },
    { name = "WASMPLANE_WASIP3_HOST_DAEMON_ROUTES", value = "1" },
    { name = "WASMPLANE_WASIP3_HOST_DAEMON_WORKER_PROXY", value = "1" },
    { name = "WASMPLANE_WASIP3_HOST_DAEMON_PORT", value = "8790" },
    { name = "WASMPLANE_WASIP3_HOST_MAX_PREPARED_COMPONENTS", value = "512" },
    { name = "WASMPLANE_WASIP3_HOST_MAX_CONCURRENT_INVOCATIONS", value = "64" }
  ]
}

resource "aws_s3_bucket" "artifacts" {
  bucket = var.artifact_bucket_name == "" ? null : var.artifact_bucket_name
  tags   = local.tags
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket                  = aws_s3_bucket.artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_ecs_cluster" "this" {
  name = var.name
  tags = local.tags
}

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "task_execution" {
  name               = "${var.name}-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "task_execution" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "task" {
  name               = "${var.name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
  tags               = local.tags
}

resource "aws_cloudwatch_log_group" "control" {
  name              = "/ecs/${var.name}/control"
  retention_in_days = 14
  tags              = local.tags
}

resource "aws_cloudwatch_log_group" "runtime" {
  name              = "/ecs/${var.name}/runtime"
  retention_in_days = 14
  tags              = local.tags
}

resource "aws_security_group" "alb" {
  name        = "${var.name}-alb"
  description = "wasmplane public ALB"
  vpc_id      = var.vpc_id
  tags        = local.tags

  ingress {
    protocol    = "tcp"
    from_port   = 80
    to_port     = 80
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    protocol    = "-1"
    from_port   = 0
    to_port     = 0
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "tasks" {
  name        = "${var.name}-tasks"
  description = "wasmplane ECS tasks"
  vpc_id      = var.vpc_id
  tags        = local.tags

  ingress {
    protocol        = "tcp"
    from_port       = 8080
    to_port         = 8080
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    protocol    = "-1"
    from_port   = 0
    to_port     = 0
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_lb" "this" {
  name               = var.name
  load_balancer_type = "application"
  subnets            = var.public_subnet_ids
  security_groups    = [aws_security_group.alb.id]
  tags               = local.tags
}

resource "aws_lb_target_group" "control" {
  name        = "${var.name}-control"
  port        = 8080
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id
  tags        = local.tags

  health_check {
    path = "/healthz"
  }
}

resource "aws_lb_target_group" "runtime" {
  name        = "${var.name}-runtime"
  port        = 8080
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id
  tags        = local.tags

  health_check {
    path = "/__runtime/healthz"
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.runtime.arn
  }
}

resource "aws_lb_listener_rule" "control_host" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 10

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.control.arn
  }

  condition {
    host_header {
      values = [var.control_host]
    }
  }
}

resource "aws_lb_listener_rule" "runtime_host" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 20

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.runtime.arn
  }

  condition {
    host_header {
      values = [var.runtime_host]
    }
  }
}

resource "aws_ecs_task_definition" "control" {
  family                   = "${var.name}-control"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "1024"
  memory                   = "2048"
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([
    {
      name         = "control"
      image        = var.control_image
      essential    = true
      command      = ["node", "--experimental-strip-types", "src/main.ts"]
      portMappings = [{ containerPort = 8080, protocol = "tcp" }]
      environment  = local.control_env
      secrets = [
        { name = "DATABASE_URL", valueFrom = var.database_url_secret_arn },
        { name = "WASMPLANE_API_TOKEN", valueFrom = var.api_token_secret_arn },
        { name = "WASMPLANE_RUNTIME_TOKEN", valueFrom = var.runtime_token_secret_arn },
        { name = "WASMPLANE_ARTIFACT_ACCESS_KEY_ID", valueFrom = var.artifact_access_key_id_secret_arn },
        { name = "WASMPLANE_ARTIFACT_SECRET_ACCESS_KEY", valueFrom = var.artifact_secret_access_key_secret_arn }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.control.name
          awslogs-region        = var.region
          awslogs-stream-prefix = "control"
        }
      }
    }
  ])

  tags = local.tags
}

resource "aws_ecs_task_definition" "runtime" {
  family                   = "${var.name}-runtime"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "1024"
  memory                   = "2048"
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([
    {
      name         = "runtime"
      image        = var.runtime_image
      essential    = true
      command      = ["node", "--experimental-strip-types", "src/runtime/main.ts"]
      portMappings = [{ containerPort = 8080, protocol = "tcp" }]
      environment  = local.runtime_env
      secrets = [
        { name = "WASMPLANE_CONTROL_PLANE_TOKEN", valueFrom = var.api_token_secret_arn },
        { name = "WASMPLANE_RUNTIME_TOKEN", valueFrom = var.runtime_token_secret_arn },
        { name = "WASMPLANE_ARTIFACT_ACCESS_KEY_ID", valueFrom = var.artifact_access_key_id_secret_arn },
        { name = "WASMPLANE_ARTIFACT_SECRET_ACCESS_KEY", valueFrom = var.artifact_secret_access_key_secret_arn }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.runtime.name
          awslogs-region        = var.region
          awslogs-stream-prefix = "runtime"
        }
      }
    }
  ])

  tags = local.tags
}

resource "aws_ecs_service" "control" {
  name            = "${var.name}-control"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.control.arn
  desired_count   = var.control_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.control.arn
    container_name   = "control"
    container_port   = 8080
  }

  depends_on = [aws_lb_listener_rule.control_host]
}

resource "aws_ecs_service" "runtime" {
  name            = "${var.name}-runtime"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.runtime.arn
  desired_count   = var.runtime_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.runtime.arn
    container_name   = "runtime"
    container_port   = 8080
  }

  depends_on = [aws_lb_listener_rule.runtime_host]
}
