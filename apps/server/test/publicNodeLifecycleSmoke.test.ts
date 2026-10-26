import { describe, expect, it } from 'vitest';
import { nodeLifecycleDisabledRefusal } from '../../../scripts/lib/smoke-public-node-lifecycle.mjs';
import { AGENT_CAPABILITY_VERSION, capabilityRefusalFor } from '../src/lib/agentCapabilities.js';

describe('public lifecycle smoke refusal contract', () => {
  it.each(['0.18.2', '0.18.3', '0.18.4', '0.19.0', '0.20.0', '1.0.0'])('matches the actual lifecycle capability policy for %s', version => {
    const refusal = capabilityRefusalFor({ version, caps: new Set() }, '#4', { cap: 'docker.lifecycle', feature: 'control immutable container state', sealedRequired: true });
    expect(refusal).not.toBeNull();
    expect(nodeLifecycleDisabledRefusal(version)).toEqual({ status: refusal!.status, code: refusal!.code });
  });
  it('covers the actual minimum agent version rather than assuming a feature-release boundary', () => {
    expect(nodeLifecycleDisabledRefusal(AGENT_CAPABILITY_VERSION['docker.lifecycle'])).toEqual({ status: 403, code: 'node_feature_disabled' });
  });
  it.each(['', '0.18', 'v0.18.3', '0.18.3-beta', 'unknown'])('refuses malformed health versions: %j', version => {
    expect(() => nodeLifecycleDisabledRefusal(version)).toThrow();
  });
});
