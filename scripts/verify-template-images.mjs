import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const registryUrl = new URL('../apps/server/src/templates/registry.json', import.meta.url);
const registry = JSON.parse(await readFile(registryUrl, 'utf8'));
const concurrency = Math.max(1, Number.parseInt(process.env.NINEDEPLOY_TEMPLATE_VERIFY_CONCURRENCY ?? '6', 10) || 6);
const queue = [...registry.templates];
const failures = [];

function inspect(template) {
  return new Promise((resolve) => {
    const child = spawn('docker', ['buildx', 'imagetools', 'inspect', template.image], {
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ ok: false, error: error.message }));
    child.on('close', (code) => resolve({
      ok: code === 0,
      error: stderr.trim().split(/\r?\n/).at(-1) ?? `exit ${code}`,
    }));
  });
}

async function worker() {
  for (;;) {
    const template = queue.shift();
    if (!template) return;
    const result = await inspect(template);
    if (result.ok) process.stdout.write(`OK   ${template.id} (${template.image})\n`);
    else {
      failures.push({ template, error: result.error });
      process.stderr.write(`FAIL ${template.id} (${template.image}): ${result.error}\n`);
    }
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()));
if (failures.length > 0) {
  process.stderr.write(`\n${failures.length}/${registry.templates.length} template images failed registry inspection.\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`\nAll ${registry.templates.length} template images have a reachable OCI manifest.\n`);
}
