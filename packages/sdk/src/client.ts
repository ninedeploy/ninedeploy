// The NineDeployClient surface, composed from the per-resource modules.
// Split out of the former single-file SDK entry (src/index.ts); the public
// surface is re-exported unchanged from there.
import { createTransport, type NineDeployClientOptions } from './transport.js';
import { authApi, type AuthApi } from './resources/auth.js';
import { servicesApi, type ServicesApi } from './resources/services.js';
import { deploysApi, type DeploysApi } from './resources/deploys.js';
import { envApi, type EnvApi } from './resources/env.js';
import { domainsApi, type DomainsApi } from './resources/domains.js';
import { networkApi, type NetworkApi } from './resources/network.js';
import { traefikApi, type TraefikApi } from './resources/traefik.js';
import { databasesApi, type DatabasesApi } from './resources/databases.js';
import { volumesApi, type VolumesApi } from './resources/volumes.js';
import { sourcesApi, type SourcesApi } from './resources/sources.js';
import { serversApi, type ServersApi } from './resources/servers.js';
import { templatesApi, type TemplatesApi } from './resources/templates.js';
import { settingsApi, type SettingsApi } from './resources/settings.js';
import { systemApi, type SystemApi } from './resources/system.js';
import { pluginsApi, type PluginsApi } from './resources/plugins.js';
import { logsApi, type LogsApi } from './resources/logs.js';
import { terminalsApi, type TerminalsApi } from './resources/terminals.js';

export interface NineDeployClient
  extends AuthApi,
    ServicesApi,
    DeploysApi,
    EnvApi,
    DomainsApi,
    NetworkApi,
    TraefikApi,
    DatabasesApi,
    VolumesApi,
    SourcesApi,
    ServersApi,
    TemplatesApi,
    SettingsApi,
    SystemApi,
    PluginsApi,
    LogsApi,
    TerminalsApi {}

/**
 * Create a typed NineDeploy API client. Used by both the web dashboard and the CLI.
 *
 * @example
 * const client = createClient({ baseUrl: 'http://localhost:3000', getToken: () => token });
 * const services = await client.services.list();
 */
export function createClient(opts: NineDeployClientOptions): NineDeployClient {
  const t = createTransport(opts);
  return {
    ...authApi(t),
    ...servicesApi(t),
    ...deploysApi(t),
    ...envApi(t),
    ...domainsApi(t),
    ...networkApi(t),
    ...traefikApi(t),
    ...databasesApi(t),
    ...volumesApi(t),
    ...sourcesApi(t),
    ...serversApi(t),
    ...templatesApi(t),
    ...settingsApi(t),
    ...systemApi(t),
    ...pluginsApi(t),
    ...logsApi(t),
    ...terminalsApi(t),
  };
}
