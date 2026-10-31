import { afterEach, expect, it, vi } from 'vitest';
import { desktopBridge, loadDesktopRefreshToken, persistDesktopRefreshToken } from '../src/lib/desktop';

afterEach(() => vi.unstubAllGlobals());
function bridge() {
  const value = { version: 1, loadRefreshToken: vi.fn(async () => 'refresh'), saveRefreshToken: vi.fn(async () => true), clearRefreshToken: vi.fn(async () => {}) };
  vi.stubGlobal('ninedeployDesktop', value);
  return value;
}

it('keeps the tab session usable when the native bridge throws synchronously', () => {
  const b = bridge();
  b.saveRefreshToken.mockImplementation(() => { throw Error('IPC disconnected'); });
  b.clearRefreshToken.mockImplementation(() => { throw Error('IPC disconnected'); });
  expect(() => persistDesktopRefreshToken('refresh')).not.toThrow();
  expect(() => persistDesktopRefreshToken(null)).not.toThrow();
});

it('handles rejected native writes without an unhandled rejection', async () => {
  const b = bridge();
  b.saveRefreshToken.mockRejectedValue(Error('credential store unavailable'));
  b.clearRefreshToken.mockRejectedValue(Error('credential store unavailable'));
  persistDesktopRefreshToken('refresh');
  persistDesktopRefreshToken(null);
  await Promise.resolve();
  expect(b.saveRefreshToken).toHaveBeenCalledWith('refresh');
  expect(b.clearRefreshToken).toHaveBeenCalledOnce();
});

it('returns no credential after a native load failure or an empty token', async () => {
  const b = bridge();
  b.loadRefreshToken.mockRejectedValueOnce(Error('credential store locked'));
  expect(await loadDesktopRefreshToken()).toBeNull();
  b.loadRefreshToken.mockResolvedValueOnce('');
  expect(await loadDesktopRefreshToken()).toBeNull();
  expect(await loadDesktopRefreshToken()).toBe('refresh');
});

it('requires the complete versioned bridge and remains usable in a browser', async () => {
  vi.stubGlobal('ninedeployDesktop', { version: 2 });
  expect(desktopBridge()).toBeNull();
  expect(await loadDesktopRefreshToken()).toBeNull();
  expect(() => persistDesktopRefreshToken('refresh')).not.toThrow();
});
