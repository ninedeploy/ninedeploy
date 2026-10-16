// @ninedeploy/sdk public entry. Every name below is part of the published API;
// the implementation lives in the modules it re-exports from (resources/*.ts
// hold one client surface each, client.ts composes them).
export { NineDeployError } from './errors.js';
export type * from '@ninedeploy/schemas';
export {
  detectProjectKind,
  formatManifestYaml,
  ManifestParseError,
  ManifestValidationError,
  parseManifestYaml,
  starterManifest,
  buildManifestFromTemplate,
} from './manifest.js';
export type { ProjectKind, TemplateRegistryEntry } from './manifest.js';

export type {
  FetchLike,
  NineDeployClientOptions,
} from './transport.js';

export type {
  JobKind,
  ScheduledJob,
  JobRun,
  TraefikVersionInfo,
  TraefikRoutingConfig,
  HealthStatus,
  VaultAllowlistView,
  VaultSettings,
  TokenIntrospection,
  TemplateDeployResult,
  TemplatePrepareResult,
  ApplyManifestResult,
  ApplyManifestInput,
  BackupDrillResult,
  BackupDrillEntry,
  LogSearchInput,
  LogSearchLine,
  LogSearchResult,
  EmailTemplateName,
  EmailTemplateEntry,
  EmailTemplateRender,
  PgbouncerStatus,
  ImageInfo,
  PruneImagesInput,
  PruneImagesResult,
  DomainVerificationChallenge,
  CreatedDomain,
  DomainVerifyResult,
  StartDomainTransferResult,
  DomainTransferPreview,
  AcceptDomainTransferInput,
  AcceptDomainTransferResult,
  DatabaseCredentialsWithPublic,
  GithubAppInstallationSync,
  SourceRepo,
  SourceUpdateInput,
  ServerListEntry,
  ServerRolesResult,
  SwarmJoinResult,
  SwarmLeaveResult,
  VolumeListEntry,
  VolumeCreateResult,
  ServiceDetail,
  NodeTerminalCapability,
  TerminalListQuery,
  TrafficQuery,
  ContainerInspectData,
  ContainerComposeData,
} from './types.js';

export {
  DATABASE_IMPORT_FINISHED_STATUSES,
} from './databaseImport.js';

export type {
  ImportWaitOptions,
  ImportFileData,
  ImportFileOptions,
} from './databaseImport.js';

export type {
  ApiQuery,
} from './apiPath.js';

export {
  apiGetUrl,
} from './apiPath.js';

export {
  AGENT_SWARM_MANAGER_VAR,
} from './types.js';

export {
  TERMINAL_SUBPROTOCOL,
  TERMINAL_TICKET_PREFIX,
  TERMINAL_INPUT_CHUNK_BYTES,
  TERMINAL_PENDING_INPUT_MAX,
  terminalAttachInfo,
  terminalCloseMessage,
  connectTerminal,
} from './terminal.js';

export type {
  TerminalAttachSource,
  WebSocketLocation,
  TerminalAttachInfo,
  TerminalSocketLike,
  TerminalSocketFactory,
  TerminalReady,
  TerminalHandlers,
  TerminalConnectOptions,
  TerminalConnection,
} from './terminal.js';

export { createClient } from './client.js';
export type { NineDeployClient } from './client.js';
