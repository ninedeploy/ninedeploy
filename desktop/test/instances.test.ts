import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InstanceStore, normalizeInstanceUrl } from '../src/instances.js';

describe('normalizeInstanceUrl', () => {
  it('reduces an address to its origin, assuming https', () => {
    expect(normalizeInstanceUrl('panel.example.com')).toEqual({ ok: true, origin: 'https://panel.example.com', insecure: false });
    expect(normalizeInstanceUrl(' https://Panel.Example.com/ ')).toEqual({ ok: true, origin: 'https://panel.example.com', insecure: false });
    expect(normalizeInstanceUrl('https://panel.example.com:8443')).toMatchObject({ origin: 'https://panel.example.com:8443' });
  });

  it('marks plain http as insecure unless it stays on this machine', () => {
    expect(normalizeInstanceUrl('http://203.0.113.7:3000')).toEqual({ ok: true, origin: 'http://203.0.113.7:3000', insecure: true });
    for (const local of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
      expect(normalizeInstanceUrl(local)).toMatchObject({ ok: true, insecure: false });
    }
  });

  it('refuses what is not exactly a panel origin', () => {
    for (const bad of ['', 'file:///etc/passwd', 'javascript:alert(1)', 'ftp://x.example', 'https://u:p@x.example', 'https://x.example/app', 'https://x.example/?a=1', 'https://x.example/#h', 'https://']) {
      expect(normalizeInstanceUrl(bad).ok, bad).toBe(false);
    }
  });
});

describe('InstanceStore', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'nd-desktop-'));
    file = path.join(dir, 'sub', 'instances.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('adds, lists, marks and removes instances, persisting them', () => {
    const store = new InstanceStore(file, () => new Date('2026-10-31T10:00:00Z'));
    expect(store.list()).toEqual([]);
    const a = store.add('Production', 'https://panel.example.com/');
    const b = store.add('', 'http://127.0.0.1:3000');
    expect(b.name).toBe('127.0.0.1:3000');
    const reopened = new InstanceStore(file);
    expect(reopened.list().map((i) => i.origin)).toEqual(['https://panel.example.com', 'http://127.0.0.1:3000']);
    store.markOpened(a.id);
    expect(store.get(a.id)?.lastOpenedAt).toBe('2026-10-31T10:00:00.000Z');
    expect(store.remove(a.id)?.name).toBe('Production');
    expect(store.list().map((i) => i.id)).toEqual([b.id]);
    expect(readFileSync(file, 'utf8')).not.toMatch(/token/i);
  });

  it('refuses a duplicate origin and an invalid address', () => {
    const store = new InstanceStore(file);
    store.add('a', 'https://panel.example.com');
    expect(() => store.add('b', 'panel.example.com')).toThrow(/already in the list/);
    expect(() => store.add('c', 'https://x.example/path')).toThrow(/without a path/);
  });

  it('ignores a corrupt file and entries that do not validate', () => {
    writeFileSync(path.join(dir, 'bad.json'), '{not json');
    expect(new InstanceStore(path.join(dir, 'bad.json')).list()).toEqual([]);
    const tampered = path.join(dir, 'tampered.json');
    writeFileSync(
      tampered,
      JSON.stringify({
        version: 1,
        instances: [
          { id: '1', name: 'ok', origin: 'https://ok.example', insecure: false, addedAt: 'x' },
          { id: '2', name: 'file', origin: 'file:///C:/', insecure: false, addedAt: 'x' },
          { id: '3', name: 'path', origin: 'https://ok.example/evil', insecure: false, addedAt: 'x' },
          'nonsense',
        ],
      }),
    );
    expect(new InstanceStore(tampered).list().map((i) => i.id)).toEqual(['1']);
  });
});
