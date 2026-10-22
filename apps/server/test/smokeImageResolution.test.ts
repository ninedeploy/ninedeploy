import { describe, expect, it } from 'vitest';
import { resolveSmokeImage } from '../../../scripts/lib/smoke-image.mjs';

describe('upgrade artifact identity', () => {
  it('never substitutes the TO candidate for the published FROM artifact at the same version', () => {
    const options = { from: 'v0.17.0', to: 'v0.17.0', toImage: 'local:candidate' };
    expect(resolveSmokeImage('from', options)).toBe('ghcr.io/ninedeploy/ninedeploy:v0.17.0');
    expect(resolveSmokeImage('to', options)).toBe('local:candidate');
  });
  it('keeps distinct version defaults and independent overrides for downgrade drills', () => {
    expect(resolveSmokeImage('from', { from: 'v0.16.15', to: 'v0.17.0' })).toBe('ghcr.io/ninedeploy/ninedeploy:v0.16.15');
    expect(resolveSmokeImage('to', { from: 'v0.16.15', to: 'v0.17.0' })).toBe('ghcr.io/ninedeploy/ninedeploy:v0.17.0');
    const overrides = { from: 'v0.17.0', to: 'v0.17.0', fromImage: 'local:new', toImage: 'local:old' };
    expect(resolveSmokeImage('from', overrides)).toBe('local:new');
    expect(resolveSmokeImage('to', overrides)).toBe('local:old');
  });
});
