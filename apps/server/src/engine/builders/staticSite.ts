import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { run } from '../../lib/exec.js';
import { resolveInRepo } from '../../lib/repoPath.js';

/**
 * Static build pack: run the repo's build commands on the host, then ship
 * the output directory inside an nginx:alpine image. The runtime, health
 * check, Traefik routing and blue-green swap are the standard docker path —
 * only the BUILD differs from a Dockerfile deploy.
 *
 * Host-executed by design (bare-metal hosts have Node; the docker-mode panel
 * container ships Node too) — remote nodes have no such guarantee, so a
 * static-pack service pinned to a node is refused upstream in the pipeline.
 */

export interface StaticBuildInput {
  workDir: string;
  baseDir: string;
  buildConfig: {
    baseDir?: string | null;
    installCmd?: string | null;
    buildCmd?: string | null;
    outputDir?: string | null;
    staticSpa?: boolean | null;
  } | undefined;
  env: Record<string, string>;
  log: (line: string) => void;
}

/** Pure: the nginx server block for the built assets. */
export function renderStaticConf(spa: boolean): string {
  const tryFiles = spa ? 'try_files $uri $uri/ /index.html;' : 'try_files $uri =404;';
  return [
    'server {',
    '  listen 80;',
    '  server_name _;',
    '  root /usr/share/nginx/html;',
    '  index index.html;',
    `  location / { ${tryFiles} }`,
    '}',
    '',
  ].join('\n');
}

/** Pure: the generated Dockerfile that ships the built assets. */
export function renderStaticDockerfile(outputDir: string): string {
  return [
    'FROM nginx:alpine',
    'COPY nginx-static.conf /etc/nginx/conf.d/default.conf',
    `COPY ${outputDir}/ /usr/share/nginx/html`,
    '',
  ].join('\n');
}

/**
 * Pure: resolve the output directory (relative to the build context) with
 * containment — COPY cannot reach outside the context, so the resolved dir
 * must live inside baseDir. Returns the absolute path plus the
 * context-relative (forward-slash) form the generated Dockerfile copies.
 */
export function resolveStaticOutput(
  baseDirAbs: string,
  outputDir: string | null | undefined,
): { abs: string; relFromBase: string } {
  const abs = path.resolve(baseDirAbs, outputDir ?? 'dist');
  const root = path.resolve(baseDirAbs);
  if (!abs.startsWith(root + path.sep)) {
    throw new Error(`static output dir escapes the build context: ${outputDir ?? 'dist'}`);
  }
  return { abs, relFromBase: path.relative(root, abs).split(path.sep).join('/') };
}

/**
 * Run the build commands on the host and produce the shippable image:
 * installCmd (optional) → buildCmd (required) → verify the output dir →
 * generate the nginx conf + a two-line Dockerfile → `docker build`.
 * `target` is the image tag the run phase expects.
 */
export async function buildStaticSite(input: StaticBuildInput, target: string): Promise<void> {
  const { workDir, buildConfig, env, log } = input;
  // baseDir uses the panel convention where '/' means repo root.
  const baseDirAbs = resolveInRepo(workDir, buildConfig?.baseDir ?? '/');

  const buildCmd = buildConfig?.buildCmd?.trim();
  if (!buildCmd) {
    throw new Error(
      'static build pack requires a build command (e.g. `npm run build`) — set it under Service → Settings → Build',
    );
  }

  const runOpts = { cwd: baseDirAbs, env, heartbeatMs: 60_000, heartbeatLabel: 'Building static assets' };
  if (buildConfig?.installCmd?.trim()) {
    log(`Running install command: ${buildConfig.installCmd}`);
    await run('sh', ['-c', buildConfig.installCmd], runOpts, log);
  }
  log(`Running build command: ${buildCmd}`);
  await run('sh', ['-c', buildCmd], runOpts, log);

  const { abs: outputAbs, relFromBase } = resolveStaticOutput(baseDirAbs, buildConfig?.outputDir ?? 'dist');
  if (!existsSync(path.join(outputAbs, 'index.html'))) {
    throw new Error(
      `the build produced no index.html in "${buildConfig?.outputDir ?? 'dist'}" — check the build command and output directory`,
    );
  }

  const spa = buildConfig?.staticSpa !== false;
  const confName = 'nginx-static.conf';
  const dockerfileName = 'Dockerfile.static';
  writeFileSync(path.join(baseDirAbs, confName), renderStaticConf(spa));
  writeFileSync(path.join(baseDirAbs, dockerfileName), renderStaticDockerfile(relFromBase));

  log(`Building static image (nginx:alpine, SPA fallback ${spa ? 'on' : 'off'}) …`);
  await run(
    'docker',
    ['build', '-t', target, '-f', dockerfileName, baseDirAbs],
    { cwd: baseDirAbs, env: { DOCKER_BUILDKIT: '1' }, heartbeatMs: 60_000, heartbeatLabel: `Building static image ${target}` },
    log,
  );
}
