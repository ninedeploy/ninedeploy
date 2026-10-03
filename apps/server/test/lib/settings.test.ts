import { describe, expect, it, vi } from 'vitest';
import { settings } from '@ninedeploy/db';
import { getSetting, getSettingJson, getSettingString, setSetting, setSettingJson, setSettingString } from '../../src/lib/settings.js';

function makeDb(row?: { key: string; value: unknown }) {
  const findFirst = vi.fn(async () => row);
  const onConflictDoUpdate = vi.fn(async () => undefined);
  const values = vi.fn(() => ({ onConflictDoUpdate }));
  const insert = vi.fn(() => ({ values }));
  return {
    db: { query: { settings: { findFirst } }, insert } as never,
    findFirst,
    values,
    onConflictDoUpdate,
    insert,
  };
}

describe('getSetting', () => {
  it('returns the stored boolean', async () => {
    const { db } = makeDb({ key: 'allow_registration', value: false });
    await expect(getSetting(db, 'allow_registration', true)).resolves.toBe(false);
  });

  it('falls back when no row exists', async () => {
    const { db } = makeDb(undefined);
    await expect(getSetting(db, 'allow_registration', true)).resolves.toBe(true);
  });

  it('falls back when the stored value is not a boolean (e.g. legacy JSON)', async () => {
    const { db } = makeDb({ key: 'k', value: 'yes' });
    await expect(getSetting(db, 'k', true)).resolves.toBe(true);
  });
});

describe('setSetting', () => {
  it('upserts the value keyed by the settings primary key', async () => {
    const h = makeDb();
    await setSetting(h.db, 'allow_registration', false);
    expect(h.insert).toHaveBeenCalledWith(settings);
    const valuesCall = (h.insert.mock.results[0]!.value as { values: ReturnType<typeof vi.fn> }).values;
    expect(valuesCall).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'allow_registration', value: false }),
    );
  });
});

describe('getSettingString', () => {
  it('returns the stored string', async () => {
    const { db } = makeDb({ key: 'acme_email', value: 'ops@example.com' });
    await expect(getSettingString(db, 'acme_email', null)).resolves.toBe('ops@example.com');
  });

  it('falls back when no row exists or the value is not a string', async () => {
    const { db } = makeDb(undefined);
    await expect(getSettingString(db, 'acme_email', 'fallback')).resolves.toBe('fallback');
    const num = makeDb({ key: 'k', value: 42 });
    await expect(getSettingString(num.db, 'k', 'fallback')).resolves.toBe('fallback');
  });
});

describe('setSettingString', () => {
  it('upserts the string value keyed by the settings primary key', async () => {
    const h = makeDb();
    await setSettingString(h.db, 'acme_email', 'ops@example.com');
    expect(h.insert).toHaveBeenCalledWith(settings);
    const valuesCall = (h.insert.mock.results[0]!.value as { values: ReturnType<typeof vi.fn> }).values;
    expect(valuesCall).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'acme_email', value: 'ops@example.com' }),
    );
  });
});

describe('getSettingJson', () => {
  it('returns parsed json from object or string, or fallback', async () => {
    const { db: objDb } = makeDb({ key: 'cfg', value: { a: 1 } });
    await expect(getSettingJson(objDb, 'cfg', null)).resolves.toEqual({ a: 1 });

    const { db: strDb } = makeDb({ key: 'cfg', value: '{"b":2}' });
    await expect(getSettingJson(strDb, 'cfg', null)).resolves.toEqual({ b: 2 });

    const { db: badDb } = makeDb({ key: 'cfg', value: '{bad-json' });
    await expect(getSettingJson(badDb, 'cfg', { fallback: true })).resolves.toEqual({ fallback: true });

    const { db: emptyDb } = makeDb(undefined);
    await expect(getSettingJson(emptyDb, 'cfg', null)).resolves.toBeNull();
  });
});

describe('setSettingJson', () => {
  it('upserts the json value', async () => {
    const h = makeDb();
    await setSettingJson(h.db, 'cfg', { test: true });
    expect(h.insert).toHaveBeenCalledWith(settings);
  });
});

