import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertEnrolmentAllowed,
  clearEnrolmentToken,
  ENROLMENT_HEADER,
  ENROLMENT_SETTING_KEY,
  getEnrolmentToken,
  rotateEnrolmentToken,
} from '../../src/lib/enrolment.js';
import { createFakeDb } from '../helpers.js';

const cryptoMocks = vi.hoisted(() => ({
  decrypt: vi.fn((v: string) => `dec:${v}`),
  encrypt: vi.fn((v: string) => `enc:${v}`),
  randomToken: vi.fn(() => 'fresh-secret-32-chars-of-entropy'),
  secretEquals: vi.fn((a: string, b: string) => a === b),
}));
vi.mock('../../src/lib/crypto.js', () => cryptoMocks);

const settingsMocks = vi.hoisted(() => ({
  getSettingString: vi.fn(async (_db: unknown, key: string) =>
    key === ENROLMENT_SETTING_KEY ? 'stored' : null,
  ),
  setSettingString: vi.fn(async () => undefined),
}));
vi.mock('../../src/lib/settings.js', () => settingsMocks);

beforeEach(() => {
  vi.clearAllMocks();
  settingsMocks.getSettingString.mockImplementation(async (_db, key) =>
    key === ENROLMENT_SETTING_KEY ? 'stored' : null,
  );
  settingsMocks.setSettingString.mockResolvedValue(undefined);
  cryptoMocks.decrypt.mockImplementation((v: string) => `dec:${v}`);
  cryptoMocks.encrypt.mockImplementation((v: string) => `enc:${v}`);
  cryptoMocks.secretEquals.mockImplementation((a: string, b: string) => a === b);
});

describe('enrolment tokens', () => {
  it('exposes the storage key and the expected header for agents', () => {
    expect(ENROLMENT_SETTING_KEY).toBe('agent_enrolment_token');
    expect(ENROLMENT_HEADER).toBe('x-ninedeploy-enrolment');
  });

  it('returns the decrypted stored token when one is configured', async () => {
    const db = createFakeDb();
    await expect(getEnrolmentToken(db as never)).resolves.toBe('dec:stored');
  });

  it('returns null when no enrolment secret has ever been generated', async () => {
    settingsMocks.getSettingString.mockResolvedValueOnce(null);
    const db = createFakeDb();
    await expect(getEnrolmentToken(db as never)).resolves.toBeNull();
  });

  it('returns null when the stored value cannot be decrypted (key rotation dropped the old key)', async () => {
    cryptoMocks.decrypt.mockImplementationOnce(() => {
      throw new Error('Unsupported state or unable to authenticate data');
    });
    const db = createFakeDb();
    await expect(getEnrolmentToken(db as never)).resolves.toBeNull();
  });

  it('rotates the enrolment token: generates fresh material, encrypts, and stores', async () => {
    const writes: Array<{ key: string; value: string }> = [];
    settingsMocks.setSettingString.mockImplementation(async (_db, key, value) => {
      writes.push({ key, value });
    });
    const db = createFakeDb();
    const token = await rotateEnrolmentToken(db as never);
    expect(token).toBe('fresh-secret-32-chars-of-entropy');
    expect(cryptoMocks.encrypt).toHaveBeenCalledWith(token);
    expect(writes).toEqual([{ key: ENROLMENT_SETTING_KEY, value: `enc:${token}` }]);
  });

  it('clears the stored enrolment by writing the empty string (announce then fails closed)', async () => {
    const writes: Array<{ key: string; value: string }> = [];
    settingsMocks.setSettingString.mockImplementation(async (_db, key, value) => {
      writes.push({ key, value });
    });
    const db = createFakeDb();
    await clearEnrolmentToken(db as never);
    expect(writes).toEqual([{ key: ENROLMENT_SETTING_KEY, value: '' }]);
  });

  it('refuses announce when no enrolment token is configured (fail-closed default)', async () => {
    settingsMocks.getSettingString.mockResolvedValueOnce(null);
    const db = createFakeDb();
    await expect(assertEnrolmentAllowed(db as never, 'whatever')).rejects.toMatchObject({
      statusCode: 401,
      code: 'enrolment_disabled',
    });
  });

  it('rejects announce when the presented header is missing', async () => {
    const db = createFakeDb();
    await expect(assertEnrolmentAllowed(db as never, undefined)).rejects.toMatchObject({
      statusCode: 401,
      code: 'enrolment_invalid',
    });
  });

  it('rejects announce when the presented header does not match the stored secret', async () => {
    cryptoMocks.secretEquals.mockReturnValueOnce(false);
    const db = createFakeDb();
    await expect(assertEnrolmentAllowed(db as never, 'wrong-token')).rejects.toMatchObject({
      statusCode: 401,
      code: 'enrolment_invalid',
    });
    expect(cryptoMocks.secretEquals).toHaveBeenCalledWith('dec:stored', 'wrong-token');
  });

  it('accepts announce when the presented header matches the stored secret (constant-time compare)', async () => {
    cryptoMocks.secretEquals.mockReturnValueOnce(true);
    const db = createFakeDb();
    await expect(assertEnrolmentAllowed(db as never, 'dec:stored')).resolves.toBeUndefined();
  });
});
