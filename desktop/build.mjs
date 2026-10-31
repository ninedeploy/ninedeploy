// Bundles the main process, the two preloads and the instance list page into
// dist/. Sandboxed preloads must be single CommonJS files, and bundling leaves
// the packaged app with no node_modules at all.
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { build } from 'esbuild';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/launcher', { recursive: true });

const common = { bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], sourcemap: false, logLevel: 'warning' };

await Promise.all([
  build({ ...common, entryPoints: ['src/main.ts'], outfile: 'dist/main.cjs' }),
  build({ ...common, entryPoints: ['src/preload-panel.ts'], outfile: 'dist/preload-panel.cjs' }),
  build({ ...common, entryPoints: ['src/preload-launcher.ts'], outfile: 'dist/preload-launcher.cjs' }),
  build({ bundle: true, platform: 'browser', target: 'chrome130', format: 'iife', entryPoints: ['src/launcher/launcher.ts'], outfile: 'dist/launcher/launcher.js', logLevel: 'warning' }),
]);
copyFileSync('src/launcher/index.html', 'dist/launcher/index.html');
copyFileSync('src/launcher/launcher.css', 'dist/launcher/launcher.css');
