/**
 * G4.4: what the build packs share across the builders, kept out of
 * engine/builders/docker.ts so the node builder (remoteDocker.ts), build
 * placement and the remote-server preflight can import it without the
 * docker.ts → fanout → remoteDocker cycle.
 */

/**
 * Cloud Native Buildpacks builder images, pinned by digest the way the
 * Nixpacks and Railpack CLIs are pinned by checksum: moving to a newer
 * builder is a code change. Paketo's base builder is amd64 only, Heroku's is
 * multi-arch.
 */
export const BUILDPACK_BUILDERS = {
  paketo: 'paketobuildpacks/builder-jammy-base@sha256:0de97a9c086f0e8777b9b1d2bca57792796cad2e9df3ddadeb32229a2507a3d0',
  heroku: 'heroku/builder:24@sha256:cb5690a66cd88740390b2ac75903d549a6b651232ff468c75aa7ef98197cc969',
} as const;

export type BuildpackPack = keyof typeof BUILDPACK_BUILDERS;

export const isBuildpackPack = (pack: string | null | undefined): pack is BuildpackPack => pack === 'paketo' || pack === 'heroku';

export const BUILDPACKS_NODE_REASON =
  'The paketo and heroku build packs build on the panel host only; nodes have no buildpacks implementation. ' +
  'Build on the panel (Service → Settings → Build → Build on: panel), or switch the build pack.';
