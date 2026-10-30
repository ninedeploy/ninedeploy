import { describe, expect, it } from 'vitest';
import { AGENT_HOME, agentDockerRunCommand } from '../src/agentCommand.js';

describe('r175: agentDockerRunCommand', () => {
  const cmd = agentDockerRunCommand({ hostPort: 4650, imageTag: 'v1.2.3', tokenSha256: 'ab'.repeat(32) });

  it('runs the AGENT entrypoint of the real image, not the default panel command', () => {
    expect(cmd).toContain('ghcr.io/ninedeploy/ninedeploy:v1.2.3 node /app/apps/server/dist/agent.js');
    expect(cmd).not.toContain('ghcr.io/ninedeploy/server');
  });

  it('mounts its state at the same path on the host and can use the docker socket', () => {
    expect(cmd).toContain(`-v ${AGENT_HOME}:${AGENT_HOME}`);
    expect(cmd).toContain(`-w ${AGENT_HOME}`);
    expect(cmd).toContain('--user 0:0');
    expect(cmd).toContain('-p 4650:4600');
  });

  it('carries the enrolment secret on the auto-join variant', () => {
    const auto = agentDockerRunCommand({ hostPort: 4600, imageTag: 'latest', masterUrl: 'https://panel.example', enrolmentToken: 'enrol-1' });
    expect(auto).toContain('-e NINEDEPLOY_MASTER_URL=https://panel.example');
    expect(auto).toContain('-e NINEDEPLOY_ENROLMENT_TOKEN=enrol-1');
    expect(auto).not.toContain('NINEDEPLOY_AGENT_TOKEN');
  });

  it('publishes on one address only when asked (a tailnet node, ROADMAP item 11)', () => {
    expect(agentDockerRunCommand({ hostPort: 4600, imageTag: 'latest', bindAddress: '100.64.0.7' })).toContain('-p 100.64.0.7:4600:4600');
  });

  it('requires a bootstrap rekey only when explicitly requested', () => {
    const options = { hostPort: 4600, imageTag: 'latest' };
    expect(agentDockerRunCommand({ ...options, requireRekey: true })).toContain('-e NINEDEPLOY_AGENT_REKEY_REQUIRED=1');
    expect(agentDockerRunCommand({ ...options, requireRekey: false })).not.toContain('NINEDEPLOY_AGENT_REKEY_REQUIRED');
  });

  it('r473: shell-metacharacter values get quoted, plain ones stay bare', () => {
    // A panel URL may legitimately carry `&` — unquoted, it backgrounds the
    // pasted command and mangles the rest of the line.
    const risky = agentDockerRunCommand({ hostPort: 4600, imageTag: 'latest', masterUrl: 'https://panel.example/?a=1&b=2', enrolmentToken: '<enrolment-token>' });
    expect(risky).toContain('-e NINEDEPLOY_MASTER_URL="https://panel.example/?a=1&b=2"');
    expect(risky).toContain('-e NINEDEPLOY_ENROLMENT_TOKEN="<enrolment-token>"');
    // The plain case stays byte-identical to the historical output.
    const plain = agentDockerRunCommand({ hostPort: 4600, imageTag: 'latest', masterUrl: 'https://panel.example', enrolmentToken: 'enrol-1' });
    expect(plain).toContain('-e NINEDEPLOY_MASTER_URL=https://panel.example -e NINEDEPLOY_ENROLMENT_TOKEN=enrol-1');
  });
});
