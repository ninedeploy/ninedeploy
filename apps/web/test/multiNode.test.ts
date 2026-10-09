import { describe, expect, it } from 'vitest';
import { errorCode, errorMessage, formatMs, isStepUpRefusal, missingFeatures, registeredNodes, swarmOptInLine } from '../src/lib/multiNode.js';

describe('multi-node helpers', () => {
  it('names the features an agent lacks, and nothing when the panel did not say', () => {
    expect(missingFeatures(undefined)).toEqual([]);
    expect(
      missingFeatures({ nixpacks: true, railpack: false, privateClones: true, volumes: false, databases: true, imageTransfer: true, swarm: false }),
    ).toEqual(['Railpack', 'Volumes', 'Swarm']);
  });

  it('keeps registered nodes only', () => {
    expect(registeredNodes(undefined)).toEqual([]);
    expect(registeredNodes([{ status: 'online' }, { status: 'pending' }, { status: 'offline' }])).toEqual([{ status: 'online' }, { status: 'offline' }]);
  });

  it('reads SDK error codes and messages', () => {
    const err = Object.assign(new Error('Invalid password'), { code: 'invalid_password' });
    expect(errorCode(err)).toBe('invalid_password');
    expect(errorCode(null)).toBeUndefined();
    expect(errorCode({ code: 42 })).toBeUndefined();
    expect(errorMessage(err, 'x')).toBe('Invalid password');
    expect(errorMessage(new Error(''), 'fallback')).toBe('fallback');
    expect(isStepUpRefusal(err)).toBe(true);
    expect(isStepUpRefusal({ code: 'reauth_required' })).toBe(true);
    expect(isStepUpRefusal({ code: 'forbidden' })).toBe(false);
  });

  it('builds the node opt-in line', () => {
    expect(swarmOptInLine('10.0.0.2:2377')).toBe('NINEDEPLOY_AGENT_SWARM_MANAGER=10.0.0.2:2377');
    expect(swarmOptInLine(null)).toBe('NINEDEPLOY_AGENT_SWARM_MANAGER=<advertise addr>:2377');
  });

  it('formats transfer durations', () => {
    expect(formatMs(null)).toBe('—');
    expect(formatMs(-1)).toBe('—');
    expect(formatMs(Number.NaN)).toBe('—');
    expect(formatMs(850)).toBe('850 ms');
    expect(formatMs(4200)).toBe('4.2 s');
    expect(formatMs(125_000)).toBe('2m 05s');
  });
});
