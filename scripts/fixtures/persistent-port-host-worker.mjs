// Owned hosted fixture, not a production IPC endpoint.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPersistentPortHostWorker } from '../../apps/server/dist/lib/persistentPortHostWorker.js';
import { PersistentPortPublicationPending } from '../../apps/server/dist/lib/persistentPortPublication.js';
import { persistentPortForwardRules, renderPersistentPortNft } from '../../apps/server/dist/lib/persistentPortNft.js';
assert.equal(process.env.ND_PORT_WORKER_FIXTURE, '1');
if (process.argv[2] === 'kernel-mutator') {
  const [directory, rulePath, mode] = process.argv.slice(3);
  assert.match(directory, /^\/proof\/worker-fence-(?:un)?fenced$/);
  appendFileSync(join(directory, 'events.log'), 'mutator-enter\n'); writeFileSync(join(directory, 'child-ready'), 'ready');
  const end = Date.now() + 20000;
  while (!existsSync(join(directory, 'release')) && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
  if (!existsSync(join(directory, 'release'))) throw new Error('Kernel child release deadline');
  execFileSync('nft', ['-f', rulePath], { timeout: 10000, stdio: mode === 'unfenced' ? 'ignore' : ['pipe', 'pipe', 'pipe', 3] });
  appendFileSync(join(directory, 'events.log'), 'mutator-finish\n');
} else {
  const controller = new AbortController(); let buffer = '', startResolve, startReject, started = false, pending;
  const initial = new Promise((resolve, reject) => { startResolve = resolve; startReject = reject; });
  const send = value => process.stdout.write(JSON.stringify(value) + '\n');
  const stop = () => { controller.abort(); if (!started) startReject(new Error('Control channel closed')); };
  const input = chunk => {
    buffer += chunk.toString(); if (Buffer.byteLength(buffer) > 65536) { stop(); return; }
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); let message;
      try { message = JSON.parse(line); } catch { stop(); return; }
      if (!started && message.type === 'start') { started = true; startResolve(message); }
      else if (started && message.type === 'ack' && pending) { const accept = pending; pending = undefined; accept(message.ack); }
      else { stop(); return; }
    }
  };
  process.stdin.on('data', input); process.stdin.on('end', stop); process.stdin.on('error', stop);
  const timer = setTimeout(stop, 45000);
  try {
    const start = await initial, directory = start.directory ?? '/proof/worker-state';
    assert.match(directory, /^\/proof\/worker-(?:state|fence-(?:un)?fenced)$/);
    assert.match(start.trace, /^[a-f0-9]{16}$/); mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, start.trace + '.pid'), String(process.pid));
    const runtime = {
      installed: async (context, table) => {
        const list = JSON.parse(context.run('nft', ['-j', 'list', 'tables']));
        if (!list.nftables.some(x => x.table?.family === 'ip' && x.table.name === table)) return null;
        return JSON.parse(context.run('nft', ['-j', 'list', 'table', 'ip', table]));
      },
      ready: async (context, spec) => {
        const info = JSON.parse(context.run('docker', ['inspect', spec.target.id]))[0];
        assert.equal(info.Id, spec.target.id); assert.equal(info.State.Running, true); assert.equal(info.NetworkSettings.Networks.backend.IPAddress, spec.target.ipv4);
        const status = context.run('docker', ['exec', spec.target.id, 'node', '-e', "fetch('http://127.0.0.1:3000/ready').then(r=>console.log(r.status))"]).trim();
        assert.equal(status, '200', 'Candidate is not ready');
      },
      prepare: async (context, spec, retained) => {
        for (const args of persistentPortForwardRules(spec, retained)) {
          try { context.run('iptables', ['-C', 'NDPI_TEST', ...args]); }
          catch { context.run('iptables', ['-A', 'NDPI_TEST', ...args]); }
        }
      },
      publish: async (context, spec, replace) => {
        const rules = renderPersistentPortNft(spec, replace);
        if (start.fault === 'fenced-child' || start.fault === 'unfenced-child') {
          const path = join(directory, 'rules.nft'); writeFileSync(path, rules);
          const args = [fileURLToPath(import.meta.url), 'kernel-mutator', directory, path, start.fault === 'unfenced-child' ? 'unfenced' : 'fenced'];
          if (start.fault === 'unfenced-child') {
            const result = spawnSync(process.execPath, args, { stdio: 'ignore', timeout: 25000 });
            if (result.status !== 0) throw new Error('Unfenced control child failed');
          } else context.run(process.execPath, args, { timeoutMs: 25000 });
        } else context.run('nft', ['-f', '-'], { input: rules });
        if (start.fault === 'kernel-ack') throw new Error('Injected lost kernel acknowledgement');
      },
      drained: async (context, target) => !context.run('conntrack', ['-L']).split('\n').some(line => line.includes('mark=' + start.request.spec.mark) && line.includes('src=' + target.ipv4 + ' ')),
      retire: async () => { throw new Error('An active native target must not be retired'); },
    };
    const result = await runPersistentPortHostWorker({ directory, request: start.request, runtime, signal: controller.signal,
      confirmWeb: (challenge, signal) => new Promise((resolve, reject) => {
        if (signal.aborted) { reject(new Error('Control channel closed')); return; }
        const abort = () => { pending = undefined; reject(new Error('Control channel closed')); };
        signal.addEventListener('abort', abort, { once: true });
        pending = value => { signal.removeEventListener('abort', abort); resolve(value); };
        send({ type: 'web', challenge });
      }),
    });
    if (directory.includes('fence')) appendFileSync(join(directory, 'events.log'), 'competitor-finish\n');
    send({ type: 'done', result, networkNamespace: execFileSync('readlink', ['/proc/self/ns/net'], { encoding: 'utf8' }).trim() });
  } catch (error) { send({ type: 'error', pending: error instanceof PersistentPortPublicationPending, message: error.message }); process.exitCode = 1; }
  finally { clearTimeout(timer); process.stdin.off('data', input); process.stdin.off('end', stop); process.stdin.off('error', stop); process.stdin.destroy(); }
}
