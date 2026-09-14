module "runtime" {
  source          = "../modules/standalone-ecs"
  name            = "oden-kumo"
  region          = "ap-northeast-1"
  image           = "000000000000.dkr.ecr.ap-northeast-1.amazonaws.com/oden:local"
  certificate_arn = "arn:aws:acm:ap-northeast-1:000000000000:certificate/00000000-0000-0000-0000-000000000000"
}
output "deployment" {
  value = module.runtime
}
