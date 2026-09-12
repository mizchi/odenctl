import assert from 'node:assert/strict';
import { classifyKumoDrift } from './kumo-drift.mjs';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const tool = process.env.TF_BIN || 'tofu';
const kumo = resolve(process.env.KUMO_BIN || 'target/kumo/v0.29.0/kumo');
const scratch = await mkdtemp(join(tmpdir(), 'wasmplane-kumo-'));
const reportDir = resolve('reports/aws-kumo');
await mkdir(reportDir, { recursive: true });
await cp('infra/terraform/aws-standalone-kumo', join(scratch, 'aws-standalone-kumo'), {
  recursive: true,
  filter: (path) => !/(^|\/)(\.terraform|terraform\.tfstate[^/]*|[^/]+\.tfplan|[^/]+\.tfvars(?:\.json)?)(\/|$)/.test(path),
});
await cp('infra/terraform/modules', join(scratch, 'modules'), { recursive: true });
const root = join(scratch, 'aws-standalone-kumo');
const reserve = createServer();
reserve.listen(0, '127.0.0.1');
await once(reserve, 'listening');
const port = reserve.address().port;
await new Promise((ok, fail) => reserve.close(e => e ? fail(e) : ok()));
const endpoint = `http://127.0.0.1:${port}`;
// Avoid ambient AWS profiles, roles, endpoint overrides, and persistent kumo data.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AWS_|TF_VAR_|KUMO_|TF_CLI_ARGS|TF_DATA_DIR|TF_WORKSPACE)/.test(key)));
Object.assign(env, { AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test', AWS_EC2_METADATA_DISABLED: 'true', TF_VAR_kumo_endpoint: endpoint, TF_IN_AUTOMATION: '1' });
const child = spawn(kumo, ['--host', '127.0.0.1', '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
let spawnError;
child.on('error', error => { spawnError = error; });
child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-100_000); });
child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-100_000); });
const exited = new Promise(ok => { child.once('exit', ok); child.once('error', ok); });
const cancellation = new AbortController();
const interrupt = () => cancellation.abort(new Error('kumo smoke interrupted'));
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
async function tf(label, args, allowChanges = false) {
  console.log(label);
  let result;
  try {
    result = await promisify(execFile)(tool, [`-chdir=${root}`, args[0], '-no-color', ...args.slice(1)], { env, timeout: 180_000, maxBuffer: 10 * 1024 * 1024, signal: cancellation.signal });
  } catch (e) {
    await writeFile(join(reportDir, `${label}.log`), `${e.stdout || ''}${e.stderr || ''}`);
    if (allowChanges && e.code === 2) result = e;
    else throw new Error(`${label} failed (exit ${e.code}); see ${join(reportDir, `${label}.log`)}`);
  }
  await writeFile(join(reportDir, `${label}.log`), `${result.stdout}${result.stderr}`);
  return result.stdout;
}
const targets = [
  'module.runtime.aws_lb_listener.https', 'module.runtime.aws_lb_listener.http',
  'module.runtime.aws_ecr_repository.app', 'module.runtime.aws_cloudwatch_log_group.app',
  'module.runtime.aws_ecs_cluster.this', 'module.runtime.aws_iam_role.execution',
  'module.runtime.aws_iam_role.task', 'module.runtime.aws_security_group.task',
].map(name => `-target=${name}`);
try {
  for (let i = 0; ; i++) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`kumo exited: ${logs}`);
    cancellation.signal.throwIfAborted();
    try { if ((await fetch(endpoint, { signal: AbortSignal.timeout(500) })).ok) break; } catch {}
    if (i >= 100) throw new Error('kumo did not become ready');
    await delay(100);
  }
  await tf('init', ['init', '-backend=false', '-input=false']);
  await tf('validate', ['validate']);
  await tf('contract-tests', ['test']);
  await tf('full-plan', ['plan', '-input=false', '-out=full.tfplan']);
  const fullPlan = JSON.parse(await tf('full-plan-json', ['show', '-json', 'full.tfplan']));
  assert.ok(fullPlan.resource_changes.some(r => r.type === 'aws_ecs_task_definition'));
  assert.ok(fullPlan.resource_changes.some(r => r.type === 'aws_ecs_service'));
  // Kumo v0.29.0 lacks these ECS read APIs. Preserve a visible capability result;
  // do not mock successful responses or hide drift with ignore_changes.
  const unsupported = [];
  for (const action of ['DescribeTaskDefinition', 'DescribeServices']) {
    const response = await fetch(endpoint, {
      method: 'POST', headers: {'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `AmazonEC2ContainerServiceV20141113.${action}`},
      body: JSON.stringify({taskDefinition: 'wasmplane-kumo', cluster: 'wasmplane-kumo', services: ['wasmplane-kumo']}),
    });
    const body = await response.text();
    if (!response.ok && body.includes('UnknownOperationException')) unsupported.push(action);
    else throw new Error(`Review kumo support for ${action}; the smoke scope may now be extended: ${body}`);
  }
  await writeFile(join(reportDir, 'coverage.json'), JSON.stringify({
    kumo: '0.29.0', fullPlan: true, fullApply: false, unsupportedEcsReadApis: unsupported,
    applyTargets: targets, containerExecutionTested: false,
  }, null, 2)+'\n');
  await tf('infra-plan', ['plan', '-input=false', '-out=infra.tfplan', ...targets]);
  await tf('infra-apply', ['apply', '-input=false', 'infra.tfplan']);
  await tf('infra-refresh', ['plan', '-input=false', '-detailed-exitcode', '-out=refresh.tfplan', ...targets], true);
  const refreshed = JSON.parse(await tf('infra-refresh-json', ['show', '-json', 'refresh.tfplan']));
  const drift = classifyKumoDrift(refreshed.resource_changes || []);
  await writeFile(join(reportDir, 'known-emulator-drift.json'), JSON.stringify(drift, null, 2)+'\n');
  console.log(`Refresh completed with ${drift.length} known kumo field round-trip differences (recorded, not ignored in Terraform).`);
  // Destroy the entire owned state: destroy targeting excludes dependencies.
  // Kumo also lacks EC2 route deletion APIs. Record only that known failure;
  // unrelated failures still fail the smoke test.
  let destroyComplete = true;
  try { await tf('infra-destroy', ['destroy', '-input=false', '-auto-approve']); }
  catch (error) {
    const output = await readFile(join(reportDir, 'infra-destroy.log'), 'utf8');
    const errors = output.split(/^Error: /m).slice(1);
    if (!errors.length || !errors.every(message => /operation error EC2: (DisassociateRouteTable|DeleteRouteTable),/.test(message) && message.includes('UnknownError'))) throw error;
    destroyComplete = false;
  }
  const state = JSON.parse(await tf('remaining-state', ['show', '-json']));
  const managed = (module) => [
    ...(module?.resources || []).filter(r => r.mode === 'managed'),
    ...(module?.child_modules || []).flatMap(managed),
  ];
  const remaining = managed(state.values?.root_module);
  if (destroyComplete) assert.equal(remaining.length, 0);
  else assert.deepEqual(remaining.map(r => r.type).sort(), [
    'aws_internet_gateway', 'aws_route_table', 'aws_route_table_association',
    'aws_route_table_association', 'aws_subnet', 'aws_subnet', 'aws_vpc',
  ].sort());
  await writeFile(join(reportDir, 'coverage.json'), JSON.stringify({
    status: 'verified-with-emulator-limitations', kumo: '0.29.0', fullPlan: true,
    fullApply: false, unsupportedEcsReadApis: unsupported, applyTargets: targets,
    knownReadDrift: drift.length, infrastructureDestroyComplete: destroyComplete,
    unsupportedEc2DeleteApis: destroyComplete ? [] : ['DisassociateRouteTable', 'DeleteRouteTable'],
    resourcesDiscardedWithEmulator: remaining.map(r => r.address),
    containerExecutionTested: false,
  }, null, 2)+'\n');
  console.log(`Verified: full plan and contract tests, supported infrastructure creation/read, ${drift.length} known read differences. Full ECS apply is unsupported; ${remaining.length} network resources are discarded with the owned in-memory emulator. Reports: ${reportDir}`);

} finally {
  // All state belongs to this process's in-memory emulator. Stop it even when
  // provider operations fail; no external daemon or AWS account is touched.
  child.kill('SIGTERM');
  const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
  await exited;
  clearTimeout(kill);
  await writeFile(join(reportDir, 'kumo.log'), logs);
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
  await rm(scratch, { recursive: true, force: true });
}
