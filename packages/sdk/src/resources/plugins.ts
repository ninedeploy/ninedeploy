// Client surface: plugins, menus.
// Split out of the former single-file SDK entry (src/index.ts); the public
// surface is re-exported unchanged from there.
import type {
  PluginListResponse,
  PluginInspectResponse,
  InstallPluginInput,
  MarketplaceCatalogResponse,
  MenuListResponse,
} from '@ninedeploy/schemas';
import type { Transport } from '../transport.js';

export interface PluginsApi {
  plugins: {
    list: () => Promise<PluginListResponse>;
    marketplace: (opts?: { refresh?: boolean }) => Promise<MarketplaceCatalogResponse>;
    install: (input: InstallPluginInput) => Promise<{ ok: boolean; id: string; status: string }>;
    enable: (id: string) => Promise<{ ok: boolean; id: string; status: string }>;
    disable: (id: string) => Promise<{ ok: boolean; id: string; status: string }>;
    reload: (id: string) => Promise<{ ok: boolean; id: string; status: string }>;
    inspect: (id: string) => Promise<PluginInspectResponse>;
    uninstall: (id: string) => Promise<{ ok: boolean; id: string }>;
  };
  menus: {
    list: (query?: { slot?: string }) => Promise<MenuListResponse>;
  };
}

export function pluginsApi(t: Transport): PluginsApi {
  const { get, send } = t;
  return {
    plugins: {
      list: () => get<PluginListResponse>('/v1/plugins'),
      marketplace: (opts) =>
        get<MarketplaceCatalogResponse>(
          `/v1/plugins/marketplace${opts?.refresh ? '?refresh=true' : ''}`,
        ),
      install: (input) => send<{ ok: boolean; id: string; status: string }>('POST', '/v1/plugins/install', input),
      enable: (id) => send<{ ok: boolean; id: string; status: string }>('POST', `/v1/plugins/${encodeURIComponent(id)}/enable`),
      disable: (id) => send<{ ok: boolean; id: string; status: string }>('POST', `/v1/plugins/${encodeURIComponent(id)}/disable`),
      reload: (id) => send<{ ok: boolean; id: string; status: string }>('POST', `/v1/plugins/${encodeURIComponent(id)}/reload`),
      inspect: (id) => get<PluginInspectResponse>(`/v1/plugins/${encodeURIComponent(id)}/inspect`),
      uninstall: (id) => send<{ ok: boolean; id: string }>('POST', `/v1/plugins/${encodeURIComponent(id)}/uninstall`),
    },
    menus: {
      list: (query) => {
        const qs = query?.slot ? `?slot=${encodeURIComponent(query.slot)}` : '';
        return get<MenuListResponse>(`/v1/menus${qs}`);
      },
    },
  };
}
