import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyKumoDrift } from '../scripts/kumo-drift.mjs';
const change = (type, before, after, name = 'app') => ({
  mode: 'managed', type, address: `module.runtime.${type}.${name}`,
  change: { actions: ['update'], before, after },
});
test('kumo drift report preserves the observed omitted TLS policy and tags', () => {
  const items = [change('aws_lb_listener', {ssl_policy: null}, {ssl_policy: 'ELBSecurityPolicy-TLS13-1-2-2021-06'}),
    change('aws_ecr_repository', {tags: {}}, {tags: {Project: 'sample'}})];
  assert.equal(classifyKumoDrift(items).length, 2);
});
test('kumo drift report rejects changes outside observed fields and replacement', () => {
  assert.throws(() => classifyKumoDrift([change('aws_lb_target_group', {health_check: [{path: '/healthz'}]}, {health_check: [{path: '/'}]})]));
  const replacement = change('aws_ecr_repository', {}, {});
  replacement.change.actions = ['delete', 'create'];
  assert.throws(() => classifyKumoDrift([replacement]));
});
test('omitted task ingress is accepted only when its planned source is the ALB', () => {
  const alb = change('aws_security_group', {id: 'sg-alb'}, {id: 'sg-alb'}, 'alb');
  alb.change.actions = ['no-op'];
  const ingress = [{from_port: 8080, to_port: 8080, protocol: 'tcp', cidr_blocks: [], ipv6_cidr_blocks: [], prefix_list_ids: [], security_groups: ['sg-alb'], self: false}];
  const task = change('aws_security_group', {ingress: []}, {ingress}, 'task');
  assert.equal(classifyKumoDrift([alb, task]).length, 1);
  task.change.after.ingress[0].cidr_blocks = ['0.0.0.0/0'];
  assert.throws(() => classifyKumoDrift([alb, task]));
});
