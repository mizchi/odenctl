import assert from 'node:assert/strict';

function changedPaths(before, after, path = '') {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (before === null || after === null || typeof before !== 'object' || typeof after !== 'object' ||
      (Array.isArray(before) && before.length !== after.length)) return [path];
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .flatMap(key => changedPaths(before[key], after[key], path ? `${path}.${key}` : key));
}

// Field omissions observed with the pinned kumo v0.29.0 binary. This records
// emulator limitations and rejects new drift; it does not alter Terraform.
export function classifyKumoDrift(changes) {
  const known = {
    aws_cloudwatch_log_group: ['tags', 'tags_all'],
    aws_ecr_repository: ['tags', 'tags_all'],
    aws_iam_role: ['tags', 'tags_all'],
    aws_lb: ['tags', 'tags_all'],
    aws_lb_listener: ['default_action.0.redirect', 'ssl_policy'],
    aws_lb_target_group: ['tags', 'tags_all', 'health_check.0.matcher'],
    aws_security_group: ['ingress'],
  };
  const drift = [];
  for (const resource of changes) {
    const {before, after, actions} = resource.change;
    if (resource.mode !== 'managed' || actions.every(action => action === 'no-op')) continue;
    assert.deepEqual(actions, ['update'], `Unexpected lifecycle drift: ${resource.address}`);
    const fields = changedPaths(before, after);
    assert.ok(fields.every(field => known[resource.type]?.some(allowed => field === allowed || field.startsWith(`${allowed}.`))),
      `Unexpected drift: ${resource.address}: ${fields}`);
    if (resource.type === 'aws_security_group') {
      assert.ok(resource.address.endsWith('.aws_security_group.task'));
      assert.deepEqual(before.ingress, []);
      assert.equal(after.ingress.length, 1);
      const rule = after.ingress[0];
      const albAddress = resource.address.replace(/\.task$/, '.alb');
      const albId = changes.find(item => item.address === albAddress)?.change.after.id;
      assert.ok(albId);
      assert.deepEqual(rule.security_groups, [albId]);
      for (const key of ['cidr_blocks', 'ipv6_cidr_blocks', 'prefix_list_ids']) assert.deepEqual(rule[key], []);
      assert.equal(rule.from_port, 8080);
      assert.equal(rule.to_port, 8080);
      assert.equal(rule.protocol, 'tcp');
      assert.equal(rule.self, false);
    }
    drift.push({address: resource.address, fields, before, after});
  }
  return drift;
}
