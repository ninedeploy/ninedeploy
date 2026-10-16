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
    listFiles: (name: string, path?: string) => Promise<{ path: string; entries: VolumeFileEntry[] }>;
    /** File manager: read a file (base64 content). */
    readFile: (name: string, path: string) => Promise<{ content: string; encoding: 'utf8' | 'base64' }>;
    /** File manager: write/overwrite a file (base64 content). */
    writeFile: (name: string, input: VolumeFileWriteInput) => Promise<{ ok: boolean }>;
    /** File manager: create a directory. */
    mkdir: (name: string, input: VolumePathCreateInput) => Promise<{ ok: boolean }>;
    /** File manager: delete a file or directory (recursive). */
    deleteFile: (name: string, path: string) => Promise<void>;
  };
  containers: {
    inspect: (container: string) => Promise<ContainerInspectData>;
    compose: (container: string) => Promise<ContainerComposeData>;
    /** File manager: list a directory inside the container. */
    listFiles: (container: string, path?: string) => Promise<{ path: string; entries: VolumeFileEntry[] }>;
    /** File manager: read a file (base64 content). */
    readFile: (container: string, path: string) => Promise<{ content: string; encoding: 'utf8' | 'base64' }>;
    /** File manager: write/overwrite a file (base64 content). */
    writeFile: (container: string, input: VolumeFileWriteInput) => Promise<{ ok: boolean }>;
    /** File manager: create a directory. */
    mkdir: (container: string, input: VolumePathCreateInput) => Promise<{ ok: boolean }>;
    makeDir: (container: string, input: VolumePathCreateInput) => Promise<{ ok: boolean }>;
    /** File manager: delete a file or directory (recursive). */
    deleteFile: (container: string, path: string) => Promise<void>;
    deletePath: (container: string, path: string) => Promise<void>;
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
  return {
    volumes: {
      list: (options) => get<VolumeListEntry[]>(apiGetUrl('/v1/volumes', { serverId: options?.serverId })),
      create: (input) => send<VolumeCreateResult>('POST', '/v1/volumes', input),
      listFiles: (name, path = '') =>
        get<{ path: string; entries: VolumeFileEntry[] }>(`/v1/volumes/${encodeURIComponent(name)}/files?path=${encodeURIComponent(path)}`),
      readFile: (name, path) =>
        get<{ content: string; encoding: 'utf8' | 'base64' }>(`/v1/volumes/${encodeURIComponent(name)}/files/content?path=${encodeURIComponent(path)}`),
      writeFile: (name, input) => send<{ ok: boolean }>('PUT', `/v1/volumes/${encodeURIComponent(name)}/files`, input),
      mkdir: (name, input) => send<{ ok: boolean }>('POST', `/v1/volumes/${encodeURIComponent(name)}/files/dir`, input),
      deleteFile: async (name, path) => {
        await request(`/v1/volumes/${encodeURIComponent(name)}/files?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
      },
      remove: async (name, options) => {
        const node = options?.serverId === undefined ? '' : `?serverId=${options.serverId}`;
        await request(`/v1/volumes/${encodeURIComponent(name)}${node}`, { method: 'DELETE' });
      },
      prune: () => send<{ ok: boolean; deleted: number; freedBytes: number }>('POST', '/v1/volumes/prune'),
    },
    containers: {
      inspect: (container) => get<ContainerInspectData>(`/v1/containers/${encodeURIComponent(container)}/inspect`),
      compose: (container) => get<ContainerComposeData>(`/v1/containers/${encodeURIComponent(container)}/compose`),
      listFiles: (container, path = '/') =>
        get<{ path: string; entries: VolumeFileEntry[] }>(`/v1/containers/${encodeURIComponent(container)}/files?path=${encodeURIComponent(path)}`),
      readFile: (container, path) =>
        get<{ content: string; encoding: 'utf8' | 'base64' }>(`/v1/containers/${encodeURIComponent(container)}/files/content?path=${encodeURIComponent(path)}`),
      writeFile: (container, input) => send<{ ok: boolean }>('PUT', `/v1/containers/${encodeURIComponent(container)}/files`, input),
      mkdir: (container, input) => send<{ ok: boolean }>('POST', `/v1/containers/${encodeURIComponent(container)}/files/dir`, input),
      makeDir: (container, input) => send<{ ok: boolean }>('POST', `/v1/containers/${encodeURIComponent(container)}/files/dir`, input),
      deleteFile: async (container, path) => {
        await request(`/v1/containers/${encodeURIComponent(container)}/files?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
      },
      deletePath: async (container, path) => {
        await request(`/v1/containers/${encodeURIComponent(container)}/files?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
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
