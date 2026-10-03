import type { DB, Domain, Service } from '@ninedeploy/db';
import { readCertificates, writeDynamicConfig } from '../../engine/proxy.js';
import { capture } from '../../lib/exec.js';
import type { IProxyDriver } from '../types.js';

export class TraefikProxyDriver implements IProxyDriver {
  readonly name = 'traefik';
  private readonly db: DB;

  constructor(db: DB) {
    this.db = db;
  }

  async syncConfiguration(_domains: Domain[], _services: Service[]): Promise<void> {
    await writeDynamicConfig(this.db);
  }

  async reload(): Promise<void> {
    try {
      await capture('docker', ['kill', '--signal=HUP', 'ninedeploy-traefik']);
    } catch {
      /* Traefik automatically watches dynamic yaml; HUP is a fallback */
    }
  }

  async getCertificateStatus(): Promise<Array<{ domain: string; valid: boolean; expiresAt?: string }>> {
    const certs = readCertificates();
    const now = Date.now();

    return certs.map((c) => ({
      domain: c.domain,
      valid: c.expiresAt ? c.expiresAt.getTime() > now : true,
      expiresAt: c.expiresAt?.toISOString(),
    }));
  }
}
