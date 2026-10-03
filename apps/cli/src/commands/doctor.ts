import { existsSync, mkdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import type { NineDeployClient } from '../client.js';
import { loadConfig } from '../config.js';
import { c, header, kv } from '../lib/format.js';
import { getContainerState, isDockerAvailable, isServerReachable, startServerContainer } from '../lib/serverRunner.js';

export interface DoctorOptions {
  fix?: boolean;
}

export async function doctorAction(client: NineDeployClient, opts: DoctorOptions = {}): Promise<void> {
  header('NineDeploy Doctor Diagnostics');

  let issues = 0;
  const prescriptions: string[] = [];
  const fixes: string[] = [];

  // 1. Environment & Memory Diagnostics
  console.log(`  ${c.bold('1. Local Environment & Memory:')}`);
  kv('Node.js', `${process.version} (${process.arch})`);
  kv('Platform', `${os.platform()} (${os.release()})`);
  const totalRamGb = (os.totalmem() / (1024 * 1024 * 1024)).toFixed(1);
  const freeRamGb = (os.freemem() / (1024 * 1024 * 1024)).toFixed(1);
  kv('System Memory', `${freeRamGb} GB free / ${totalRamGb} GB total`);

  // Swap space check (Linux)
  /* v8 ignore start */
  if (os.platform() === 'linux') {
    try {
      const fs = await import('node:fs/promises');
      const meminfo = await fs.readFile('/proc/meminfo', 'utf8').catch(() => '');
      const swapMatch = meminfo.match(/SwapTotal:\s+(\d+)\s+kB/);
      const swapKb = swapMatch?.[1] ? Number.parseInt(swapMatch[1], 10) : 0;
      const swapMb = Math.round(swapKb / 1024);
      if (swapMb < 1024 && Number.parseFloat(totalRamGb) <= 4) {
        kv('Swap Memory', c.yellow(`${swapMb} MB (Low - recommended ≥ 2GB for heavy Docker pulls)`));
        prescriptions.push('Allocate 2GB swap space: sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile');
      } else {
        kv('Swap Memory', c.green(`${swapMb} MB`));
      }
    } catch {
      /* ignore */
    }
  }
  /* v8 ignore stop */
  console.log();

  // 2. Docker & Process Engine Diagnostics
  console.log(`  ${c.bold('2. Docker & Process Daemon:')}`);
  const dockerOk = await isDockerAvailable();
  if (dockerOk) {
    kv('Docker CLI', c.green('available'));
    const container = await getContainerState('ninedeploy');
    if (container.exists) {
      kv('Docker Container', container.running ? c.green('running') : c.yellow('stopped'));
      if (!container.running) {
        if (opts.fix) {
          try {
            await startServerContainer({});
            fixes.push('Started stopped ninedeploy Docker container.');
          } catch (err) {
            prescriptions.push(`Start server container: ninedeploy server start (${String(err)})`);
          }
        } else {
          prescriptions.push('Start server container: ninedeploy server start');
        }
      }
    } else {
      kv('Docker Container', c.gray('not in use (baremetal / systemd mode)'));
    }
  } else {
    kv('Docker CLI', c.yellow('not found or daemon not running'));
    prescriptions.push('Install or start Docker Engine: sudo systemctl start docker (or https://docs.docker.com/engine/install/)');
    issues++;
  }
  console.log();

  // 3. Local Storage & Database Integrity
  console.log(`  ${c.bold('3. Local Storage & Database:')}`);
  /* v8 ignore start */
  const optDataDir = '/opt/ninedeploy/.data';
  const defaultDataDir = existsSync(path.resolve(process.cwd(), '.data'))
    ? path.resolve(process.cwd(), '.data')
    : (existsSync(optDataDir) ? optDataDir : path.resolve(process.cwd(), '.data'));
  const dbFile = path.join(defaultDataDir, 'ninedeploy.db');
  if (existsSync(defaultDataDir)) {
    kv('.data Directory', c.green(`exists (${defaultDataDir})`));
    if (existsSync(dbFile)) {
      try {
        const stats = statSync(dbFile);
        kv('SQLite Database', c.green(`present (${(stats.size / 1024).toFixed(1)} KB)`));
      } catch {
        kv('SQLite Database', c.yellow('found (unable to read stats)'));
      }
    } else {
      kv('SQLite Database', c.gray('fresh (will be created on first start)'));
    }
  } else {
    kv('.data Directory', c.gray('not present in cwd or /opt/ninedeploy'));
    if (opts.fix) {
      try {
        mkdirSync(defaultDataDir, { recursive: true });
        fixes.push('Created missing .data directory.');
      } catch {
        /* ignore */
      }
    }
  }
  /* v8 ignore stop */
  console.log();

  // 4. Server Reachability & API Health
  const cfg = loadConfig();
  console.log(`  ${c.bold('4. NineDeploy Server:')}`);
  kv('Target URL', cfg.baseUrl);
  const start = Date.now();
  const reachable = await isServerReachable(cfg.baseUrl, 1500);
  const latency = Date.now() - start;
  if (reachable) {
    kv('Connectivity', c.green(`connected (${latency}ms)`));
  } else {
    kv('Connectivity', c.red('unreachable'));
    prescriptions.push(`Ensure NineDeploy is running at ${cfg.baseUrl}: sudo systemctl status ninedeploy (or ninedeploy server start)`);
    issues++;
  }
  console.log();

  // 5. Authentication Check
  console.log(`  ${c.bold('5. Authentication & Credentials:')}`);
  if (!cfg.token) {
    kv('Session', c.yellow('not logged in (run `ninedeploy login` or `ninedeploy setup`)'));
  } else {
    try {
      const user = await client.auth.me();
      kv('Logged In User', `${user.email} (${user.isOperator ? 'operator' : 'member'})`);
      kv('Token Status', c.green('valid'));
    } catch {
      kv('Token Status', c.red('invalid or expired'));
      prescriptions.push('Re-authenticate: ninedeploy login (or ninedeploy setup)');
      issues++;
    }
  }
  console.log();

  // Summary & Prescriptions
  if (fixes.length > 0) {
    console.log(`  ${c.bold('Healed Issues (--fix):')}`);
    for (const fix of fixes) {
      console.log(`    ${c.green('✓')} ${fix}`);
    }
    console.log();
  }

  if (prescriptions.length > 0) {
    console.log(`  ${c.bold('Prescriptions & Solutions:')}`);
    for (const rx of prescriptions) {
      console.log(`    ${c.cyan('➜')} ${rx}`);
    }
    console.log();
  }

  if (issues === 0) {
    console.log(`  ${c.green('✓ All critical checks passed. NineDeploy CLI is ready.')}\n`);
  } else {
    console.log(`  ${c.yellow(`! Found ${issues} issue(s). Check the items marked in red above.`)}\n`);
  }
}
