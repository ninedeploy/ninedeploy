import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const repo = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), 'utf8');

/** Guards for the deployment artefacts the server's code depends on. */
describe('infrastructure guards', () => {
  it('r246: the runtime image ships the compose and buildx CLI plugins', () => {
    const dockerfile = repo('Dockerfile');
    expect(dockerfile).toContain('/usr/local/lib/docker/cli-plugins');
    expect(dockerfile).toMatch(/docker-compose-linux-\$\{COMPOSE_ARCH\}/);
    expect(dockerfile).toMatch(/buildx-v\$\{BUILDX_VERSION\}\.linux-\$\{TARGETARCH\}/);
    expect(dockerfile).toContain('docker compose version');
  });

  it('r248: the hardened systemd unit lets the firewall manager write /etc/ufw', () => {
    const unit = repo('systemd/ninedeploy.service');
    const line = unit.split('\n').find((l) => l.startsWith('ReadWritePaths='));
    expect(line).toContain('-/etc/ufw');
    expect(unit).toContain('ProtectSystem=full');
  });
});
