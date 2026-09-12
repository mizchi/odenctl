import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const version = '0.29.0';
const hashes = {
  darwin_amd64: 'f6eef306e4621d5b4e8cce94272fcf7e997334fb15a90eb9f83a89ab94652f6c',
  darwin_arm64: '63a2430b6b1b37960d17e81741a534242c76a8007355eda66c4acad3099c135d',
  linux_amd64: '53df3b60aed35ccec0484839c83ba6e6ae055e3387a45984106298ba8455dea0',
  linux_arm64: '8c2e40ce2d4b2bdb4c259277d652f71294d4c9035e0c3d9cb319459e28bd4680',
};
const target = `${platform()}_${arch() === 'x64' ? 'amd64' : arch()}`;
if (!hashes[target]) throw new Error(`Unsupported kumo platform: ${target}`);
const destination = resolve(`target/kumo/v${version}`);
const archive = `kumo_${version}_${target}.tar.gz`;
await mkdir(destination, { recursive: true });
let bytes;
try { bytes = await readFile(join(destination, archive)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
if (!bytes) {
  const response = await fetch(`https://github.com/sivchari/kumo/releases/download/v${version}/${archive}`, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`kumo download: HTTP ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
}
if (createHash('sha256').update(bytes).digest('hex') !== hashes[target]) throw new Error('kumo archive checksum mismatch');
await writeFile(join(destination, archive), bytes);
const staging = await mkdtemp(join(destination, '.extract-'));
try {
  await promisify(execFile)('tar', ['-xzf', join(destination, archive), '-C', staging, 'kumo']);
  await chmod(join(staging, 'kumo'), 0o755);
  await rename(join(staging, 'kumo'), join(destination, 'kumo'));
} finally { await rm(staging, { recursive: true, force: true }); }
console.log(`Installed kumo v${version}: ${join(destination, 'kumo')}`);
