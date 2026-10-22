import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// October 21, 2026 security releases. Review new major lines before admitting them.
export const NODE_SECURITY_RANGE = '^22.23.4 || ^24.22.1 || ^26.12.1';
export function isSupportedNodeVersion(version) {
  const parts = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!parts) return false;
  const [major, minor, patch] = parts.slice(1).map(Number);
  const floor = new Map([[22, [23, 4]], [24, [22, 1]], [26, [12, 1]]]).get(major);
  return !!floor && (minor > floor[0] || (minor === floor[0] && patch >= floor[1]));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!isSupportedNodeVersion(process.versions.node)) {
    console.error(`Node.js ${process.versions.node} does not meet NineDeploy's security baseline (${NODE_SECURITY_RANGE}). Upgrade Node.js before continuing.`);
    process.exitCode = 1;
  } else {
    console.log(`Node.js ${process.versions.node}: security baseline satisfied`);
  }
}
