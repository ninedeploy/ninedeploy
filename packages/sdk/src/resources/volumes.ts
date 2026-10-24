// Client surface: volumes, containers, serviceVolumes.
// Split out of the former single-file SDK entry (src/index.ts); the public
// surface is re-exported unchanged from there.
import type {
  CreateServiceVolumeAttachmentInput,
  ServiceVolumeAttachment,
  UpdateServiceVolumeAttachmentInput,
  VolumeFileEntry,
  VolumeFileWriteInput,
  VolumePathCreateInput,
  VolumeCreateInput,
} from '@ninedeploy/schemas';
import { apiGetUrl } from '../apiPath.js';
import type { VolumeListEntry, VolumeCreateResult, ContainerInspectData, ContainerComposeData } from '../types.js';
import type { Transport } from '../transport.js';

export interface VolumesApi {
  volumes: {
    /**
     * Managed volumes on the panel host or (0.16 T8) with `serverId` on a
     * node, through its agent; node entries carry `serverId`. An older agent
     * answers 422 `node_agent_outdated`.
     */
    list: (options?: { serverId?: number }) => Promise<VolumeListEntry[]>;
    /** Delete a retained volume; with `serverId` (r466) on that node. */
    remove: (name: string, options?: { serverId?: number }) => Promise<void>;
    /**
     * 0.16 T8: create a managed volume (`nd-svc-*` / `nd-db-*`) on the panel
     * host or, with `serverId`, on a node. An existing volume answers 409
     * `node_volume_exists`.
     */
    create: (input: VolumeCreateInput) => Promise<VolumeCreateResult>;
    prune: () => Promise<{ ok: boolean; deleted: number; freedBytes: number }>;
    /** File manager: list a directory inside the volume. */
    listFiles: (name: string, path?: string, options?: { serverId?: number }) => Promise<{ path: string; entries: VolumeFileEntry[] }>;
    /** File manager: read a file (base64 content). */
    readFile: (name: string, path: string, options?: { serverId?: number }) => Promise<{ content: string; encoding: 'utf8' | 'base64' }>;
    /** File manager: write/overwrite a file (base64 content). */
    writeFile: (name: string, input: VolumeFileWriteInput, options?: { serverId?: number }) => Promise<{ ok: boolean }>;
    /** File manager: create a directory. */
    mkdir: (name: string, input: VolumePathCreateInput, options?: { serverId?: number }) => Promise<{ ok: boolean }>;
    /** File manager: delete a file or directory (recursive). */
    deleteFile: (name: string, path: string, options?: { serverId?: number }) => Promise<void>;
  };
  containers: {
    inspect: (container: string, options?: { serverId?: number }) => Promise<ContainerInspectData>;
    compose: (container: string, options?: { serverId?: number }) => Promise<ContainerComposeData>;
    /** File manager: list a directory inside the container. */
    listFiles: (container: string, path?: string, options?: { serverId?: number }) => Promise<{ path: string; entries: VolumeFileEntry[] }>;
    /** File manager: read a file (base64 content). */
    readFile: (container: string, path: string, options?: { serverId?: number }) => Promise<{ content: string; encoding: 'utf8' | 'base64' }>;
    /** File manager: write/overwrite a file (base64 content). */
    writeFile: (container: string, input: VolumeFileWriteInput, options?: { serverId?: number }) => Promise<{ ok: boolean }>;
    /** File manager: create a directory. */
    mkdir: (container: string, input: VolumePathCreateInput, options?: { serverId?: number }) => Promise<{ ok: boolean }>;
    makeDir: (container: string, input: VolumePathCreateInput, options?: { serverId?: number }) => Promise<{ ok: boolean }>;
    /** File manager: delete a file or directory (recursive). */
    deleteFile: (container: string, path: string, options?: { serverId?: number }) => Promise<void>;
    deletePath: (container: string, path: string, options?: { serverId?: number }) => Promise<void>;
  };
  /** Per-service additional volume attachments. Distinct from the instance-wide
   * `volumes` namespace (which lists every Docker volume on the host). The
   * list endpoint returns runtime-computed metadata (size, in-use, sharing);
   * the create/update endpoints return the database row only. */
  serviceVolumes: {
    list: (serviceId: number) => Promise<Array<ServiceVolumeAttachment & { sizeBytes: number; inUse: boolean; sharedWith: number }>>;
    /** Attach an existing managed volume or create a new one and attach it. */
    create: (serviceId: number, input: CreateServiceVolumeAttachmentInput) => Promise<{ attachment: ServiceVolumeAttachment; deploymentId: number }>;
    update: (serviceId: number, attachmentId: number, input: UpdateServiceVolumeAttachmentInput) => Promise<{ attachment: ServiceVolumeAttachment; deploymentId: number }>;
    /** Detach. The underlying Docker volume is NOT deleted (data persists). */
    remove: (serviceId: number, attachmentId: number) => Promise<void>;
    /** Delete a first-boot-baked config file from the volume and queue a
     *  redeploy so the app regenerates it from the current environment
     *  (WordPress wp-config.php et al.). Exactly one of `attachmentId` /
     *  `volumeName` must be set; `filePath` is a single path segment. */
    repairConfig: (
      serviceId: number,
      input: { filePath: string; attachmentId?: number; volumeName?: string },
    ) => Promise<{ ok: boolean; deploymentId: number }>;
  };
}

export function volumesApi(t: Transport): VolumesApi {
  const { get, send, request } = t;
  const volumePath = (name: string, suffix: string, options?: { serverId?: number }) => {
    const id = options?.serverId;
    if (id != null && (!Number.isSafeInteger(id) || id < 1)) throw new TypeError('Invalid volume node id');
    const prefix = id == null ? '/v1/volumes' : `/v1/servers/${id}/volumes`;
    return `${prefix}/${encodeURIComponent(name)}${suffix}`;
  };
  const containerPath = (container: string, suffix: string, options?: { serverId?: number }) => {
    const id = options?.serverId;
    if (id != null && (!Number.isSafeInteger(id) || id < 1)) throw new TypeError('Invalid container node id');
    // An older panel returns 404 for this namespace instead of ignoring a host
    // query and accidentally editing a same-named local container.
    const prefix = id == null ? '/v1/containers' : `/v1/servers/${id}/containers`;
    return `${prefix}/${encodeURIComponent(container)}${suffix}`;
  };
  return {
    volumes: {
      list: (options) => get<VolumeListEntry[]>(apiGetUrl('/v1/volumes', { serverId: options?.serverId })),
      create: (input) => send<VolumeCreateResult>('POST', '/v1/volumes', input),
      listFiles: (name, path = '', options) =>
        request<{ path: string; entries: VolumeFileEntry[] }>(`${volumePath(name, '/files', options)}?path=${encodeURIComponent(path)}`, {}, 150_000),
      readFile: (name, path, options) =>
        request<{ content: string; encoding: 'utf8' | 'base64' }>(`${volumePath(name, '/files/content', options)}?path=${encodeURIComponent(path)}`, {}, 150_000),
      writeFile: (name, input, options) => request<{ ok: boolean }>(volumePath(name, '/files', options), { method: 'PUT', body: input }, 150_000),
      mkdir: (name, input, options) => request<{ ok: boolean }>(volumePath(name, '/files/dir', options), { method: 'POST', body: input }, 150_000),
      deleteFile: async (name, path, options) => {
        await request(`${volumePath(name, '/files', options)}?path=${encodeURIComponent(path)}`, { method: 'DELETE' }, 150_000);
      },
      remove: async (name, options) => {
        const node = options?.serverId === undefined ? '' : `?serverId=${options.serverId}`;
        await request(`/v1/volumes/${encodeURIComponent(name)}${node}`, { method: 'DELETE' });
      },
      prune: () => send<{ ok: boolean; deleted: number; freedBytes: number }>('POST', '/v1/volumes/prune'),
    },
    containers: {
      inspect: (container, options) => get<ContainerInspectData>(containerPath(container, '/inspect', options)),
      compose: (container, options) => get<ContainerComposeData>(containerPath(container, '/compose', options)),
      listFiles: (container, path = '/', options) =>
        get<{ path: string; entries: VolumeFileEntry[] }>(`${containerPath(container, '/files', options)}?path=${encodeURIComponent(path)}`),
      readFile: (container, path, options) =>
        get<{ content: string; encoding: 'utf8' | 'base64' }>(`${containerPath(container, '/files/content', options)}?path=${encodeURIComponent(path)}`),
      writeFile: (container, input, options) => send<{ ok: boolean }>('PUT', containerPath(container, '/files', options), input),
      mkdir: (container, input, options) => send<{ ok: boolean }>('POST', containerPath(container, '/files/dir', options), input),
      makeDir: (container, input, options) => send<{ ok: boolean }>('POST', containerPath(container, '/files/dir', options), input),
      deleteFile: async (container, path, options) => {
        await request(`${containerPath(container, '/files', options)}?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
      },
      deletePath: async (container, path, options) => {
        await request(`${containerPath(container, '/files', options)}?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
      },
    },
    serviceVolumes: {
      list: (serviceId) => get<Array<ServiceVolumeAttachment & { sizeBytes: number; inUse: boolean; sharedWith: number }>>(`/v1/services/${serviceId}/volumes`),
      create: (serviceId, input) =>
        send<{ attachment: ServiceVolumeAttachment; deploymentId: number }>('POST', `/v1/services/${serviceId}/volumes`, input),
      update: (serviceId, attachmentId, input) =>
        send<{ attachment: ServiceVolumeAttachment; deploymentId: number }>(
          'PATCH',
          `/v1/services/${serviceId}/volumes/${attachmentId}`,
          input,
        ),
      remove: async (serviceId, attachmentId) => {
        await request(`/v1/services/${serviceId}/volumes/${attachmentId}`, { method: 'DELETE' });
      },
      repairConfig: (serviceId, input) =>
        send<{ ok: boolean; deploymentId: number }>('POST', `/v1/services/${serviceId}/volumes/config-repair`, input),
    },
  };
}
