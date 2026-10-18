// Client surface: networks, tunnels, firewall, egress.
// Split out of the former single-file SDK entry (src/index.ts); the public
// surface is re-exported unchanged from there.
import type {
  CreateTunnelInput,
  TunnelEntry,
} from '@ninedeploy/schemas';
import type { Transport } from '../transport.js';

/** 0.16.1: one address of the panel host, as `GET /v1/host-ips` lists it. */
export interface HostIpEntry {
  ip: string;
  family: 4 | 6;
  /** Interface the host reports it on; null when not detected (an address saved earlier). */
  iface: string | null;
  detected: boolean;
  label: string | null;
  primary: boolean;
  dedicatedTo: { id: number; name: string } | null;
}

export interface NetworkApi {
  /** 0.16.1 IP inventory of the panel host (operator, except `primary`). */
  hostIps: {
    list: () => Promise<{ detected: boolean; addresses: HostIpEntry[] }>;
    /** The primary address, for DNS hints (any signed-in user). */
    primary: () => Promise<{ ip: string | null }>;
    /** Label it, make it primary, or dedicate it to a docker service on the panel host (`serviceId: null` shares it again). */
    set: (ip: string, patch: { label?: string | null; primary?: boolean; serviceId?: number | null }) => Promise<HostIpEntry | null>;
    /** Forget what was saved about an address. */
    remove: (ip: string) => Promise<{ ok: boolean }>;
  };
  networks: {
    list: () => Promise<{
      networks: Array<{
        name: string;
        driver: string;
        members: string[];
        /** True when the network is reserved by NineDeploy (cannot be removed). */
        isManaged?: boolean;
      }>;
      remote: number | null;
    }>;
    create: (input: { name: string; driver?: 'bridge' | 'overlay'; serverId?: number | null }) => Promise<{ ok: boolean; name: string }>;
    remove: (name: string, serverId?: number) => Promise<{ ok: boolean }>;
    attach: (input: { network: string; container: string; serverId?: number | null }) => Promise<{ ok: boolean }>;
    detach: (input: { network: string; container: string; serverId?: number | null }) => Promise<{ ok: boolean }>;
    /**
     * r557: container names attached to one network (operator-only). The
     * server answers `{ members: [] }` when docker cannot inspect it.
     */
    members: (name: string) => Promise<{ members: string[] }>;
  };
  tunnels: {
    list: () => Promise<TunnelEntry[]>;
    create: (input: CreateTunnelInput) => Promise<TunnelEntry>;
    remove: (id: number) => Promise<void>;
  };
  firewall: {
    status: () => Promise<{
      installed: boolean;
      active: boolean;
      supported: boolean;
      rules: Array<{ id: number; to: string; action: string; from: string; comment?: string }>;
      defaultIncoming: string;
      defaultOutgoing: string;
    }>;
    toggle: (enabled: boolean) => Promise<{ ok: boolean; status: any }>;
    addRule: (input: { port: number | string; proto?: 'tcp' | 'udp' | 'any'; action?: 'allow' | 'deny' | 'limit'; from?: string; comment?: string }) => Promise<{ ok: boolean; status: any }>;
    deleteRule: (id: number | string) => Promise<{ ok: boolean; status: any }>;
    applyRecommended: () => Promise<{ ok: boolean; status: any }>;
  };
  egress: {
    /** Every egress IP rule across every registered driver. G-15. */
    list: () => Promise<{
      drivers: Array<{
        name: string;
        rules: Array<{
          selector: { projectId: number; sourceCidr?: string };
          ip: string;
          createdAt: string;
        }>;
      }>;
    }>;
    /** Attach an egress IP to a project on the named (or first) driver. */
    set: (input: { projectId: number; ip: string; driver?: string }) => Promise<{
      ok: boolean;
      driver: string;
      rule: { selector: { projectId: number; sourceCidr?: string }; ip: string; createdAt: string };
      /** Present (with `ok: false`) when the route refused the request. */
      error?: string;
    }>;
    /** Detach the rule for a project (on the named or first driver). */
    clear: (projectId: number, driver?: string) => Promise<{ ok: boolean; driver: string; error?: string }>;
  };
}

export function networkApi(t: Transport): NetworkApi {
  const { get, send, request } = t;
  return {
    hostIps: {
      list: () => get<{ detected: boolean; addresses: HostIpEntry[] }>('/v1/host-ips'),
      primary: () => get<{ ip: string | null }>('/v1/host-ips/primary'),
      set: (ip, patch) => send<HostIpEntry | null>('PUT', `/v1/host-ips/${encodeURIComponent(ip)}`, patch),
      remove: (ip) => send<{ ok: boolean }>('DELETE', `/v1/host-ips/${encodeURIComponent(ip)}`),
    },
    networks: {
      list: () => get<{ networks: Array<{ name: string; driver: string; members: string[] }>; remote: number | null }>('/v1/networks'),
      create: (input) => send<{ ok: boolean; name: string }>('POST', '/v1/networks', { driver: 'bridge', ...input }),
      remove: (name, serverId) =>
        send<{ ok: boolean }>('DELETE', `/v1/networks/${encodeURIComponent(name)}${serverId != null ? `?serverId=${serverId}` : ''}`),
      attach: (input) => send<{ ok: boolean }>('POST', '/v1/networks/attach', input),
      detach: (input) => send<{ ok: boolean }>('POST', '/v1/networks/detach', input),
      members: (name) => get<{ members: string[] }>(`/v1/networks/${encodeURIComponent(name)}/members`),
    },
    tunnels: {
      list: () => get<TunnelEntry[]>('/v1/tunnels'),
      create: (input) => send<TunnelEntry>('POST', '/v1/tunnels', input),
      remove: async (id) => {
        await request(`/v1/tunnels/${id}`, { method: 'DELETE' });
      },
    },
    firewall: {
      status: () => get<any>('/v1/firewall'),
      toggle: (enabled) => send<any>('POST', '/v1/firewall/toggle', { enabled }),
      addRule: (input) => send<any>('POST', '/v1/firewall/rules', input),
      deleteRule: (id) => request(`/v1/firewall/rules/${id}`, { method: 'DELETE' }),
      applyRecommended: () => send<any>('POST', '/v1/firewall/recommended'),
    },
    egress: {
      list: () => get<{
        drivers: Array<{
          name: string;
          rules: Array<{
            selector: { projectId: number; sourceCidr?: string };
            ip: string;
            createdAt: string;
          }>;
        }>;
      }>('/v1/egress'),
      set: (input) => send<{
        ok: boolean;
        driver: string;
        rule: { selector: { projectId: number; sourceCidr?: string }; ip: string; createdAt: string };
        error?: string;
      }>('POST', '/v1/egress', input),
      clear: (projectId, driver) =>
        send<{ ok: boolean; driver: string; error?: string }>(
          'DELETE',
          `/v1/egress/${projectId}${driver ? `?driver=${encodeURIComponent(driver)}` : ''}`,
        ),
    },
  };
}
