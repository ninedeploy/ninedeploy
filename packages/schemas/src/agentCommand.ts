/**
 * The one `docker run` line that starts a NineDeploy node agent (r175).
 *
 * It used to be written out three times — SSH bootstrap, the register API
 * and the Servers page — and all three were wrong in different ways: the
 * API/web copies named an image that does not exist
 * (`ghcr.io/ninedeploy/server`), none of them told the image to run the
 * agent instead of the panel, the auto-join copy had no enrolment token
 * (so `/announce` always refused it), and the in-container agent could
 * neither reach the docker socket (non-root image user) nor hand Traefik
 * bind mounts that exist on the host.
 *
 * The agent keeps all state relative to its working directory, so it runs
 * in AGENT_HOME, bind-mounted at the SAME path on the host: every `-v`
 * the agent passes to the host daemon (Traefik config, acme.json, env files)
 * then names a real host path, and a generated auto-join token survives a
 * container re-create. It runs as root because docker-socket access is
 * root-equivalent anyway and the socket is `root:docker 0660`.
 */
export const AGENT_HOME = '/var/lib/ninedeploy-agent';
export const AGENT_CONTAINER_PORT = 4600;
export const AGENT_IMAGE_REPO = 'ghcr.io/ninedeploy/ninedeploy';

export interface AgentCommandOptions {
  /** Host port the agent is published on. */
  hostPort: number;
  /** Image tag, e.g. `v0.10.0`; `latest` when the caller cannot pin it. */
  imageTag: string;
  /** Manual registration: sha256 of the shared token the core holds. */
  tokenSha256?: string;
  /** Auto-join: the core's public URL to announce to. */
  masterUrl?: string;
  /** Auto-join: the admin-issued enrolment secret (or a placeholder to fill in). */
  enrolmentToken?: string;
}

export function agentDockerRunCommand(opts: AgentCommandOptions): string {
  const env: string[] = [
    'NINEDEPLOY_AGENT=1',
    `NINEDEPLOY_AGENT_PORT=${AGENT_CONTAINER_PORT}`,
  ];
  if (opts.tokenSha256) env.push(`NINEDEPLOY_AGENT_TOKEN=${opts.tokenSha256}`);
  if (opts.masterUrl) env.push(`NINEDEPLOY_MASTER_URL=${opts.masterUrl}`);
  if (opts.enrolmentToken) env.push(`NINEDEPLOY_ENROLMENT_TOKEN=${opts.enrolmentToken}`);
  return [
    'docker run -d --name ninedeploy-agent --restart unless-stopped',
    '--user 0:0',
    `-p ${opts.hostPort}:${AGENT_CONTAINER_PORT}`,
    '-v /var/run/docker.sock:/var/run/docker.sock',
    `-v ${AGENT_HOME}:${AGENT_HOME}`,
    `-w ${AGENT_HOME}`,
    ...env.map((e) => `-e ${e}`),
    `${AGENT_IMAGE_REPO}:${opts.imageTag}`,
    'node /app/apps/server/dist/agent.js',
  ].join(' ');
}
