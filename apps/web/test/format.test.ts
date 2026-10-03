import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { downloadBlob, formatBytes, formatDateTime, formatDuration, formatRelative, useCopy } from '../src/lib/format.js';

describe('formatBytes', () => {
  it('formats bytes and small values without decimals', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(-5)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
  });

  it('formats decimal units with one decimal place', () => {
    expect(formatBytes(1500)).toBe('1.5 KB');
    expect(formatBytes(5 * 1000 * 1000)).toBe('5.0 MB');
    expect(formatBytes(2 * 1000 ** 3)).toBe('2.0 GB');
  });

  it('caps at the largest supported unit', () => {
    expect(formatBytes(3 * 1000 ** 5)).toBe('3.0 PB');
  });
});

describe('formatDateTime', () => {
  it('formats a fixed-locale timestamp', () => {
    expect(formatDateTime(new Date(2026, 0, 2, 3, 4))).toMatch(/02 Jan 2026.*03:04/);
  });

  it('accepts ISO strings and numbers', () => {
    const iso = '2026-08-15T10:30:00.000Z';
    expect(formatDateTime(iso)).toMatch(/30/);
    expect(formatDateTime(Date.UTC(2026, 7, 15, 10, 30))).toBe(formatDateTime(iso));
  });
});

describe('formatRelative', () => {
  it('returns just now for recent timestamps', () => {
    expect(formatRelative(Date.now() - 10_000)).toBe('just now');
  });

  it('returns minutes, hours and days ago', () => {
    expect(formatRelative(Date.now() - 5 * 60_000)).toBe('5m ago');
    expect(formatRelative(Date.now() - 3 * 3600_000)).toBe('3h ago');
    expect(formatRelative(Date.now() - 2 * 86_400_000)).toBe('2d ago');
  });
});

describe('formatDuration', () => {
  it('returns a dash for invalid input', () => {
    expect(formatDuration(Number.NaN)).toBe('—');
    expect(formatDuration(-1)).toBe('—');
  });

  it('formats seconds below a minute', () => {
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(59.6)).toBe('59s');
  });

  it('formats minutes and hours with padded remainder', () => {
    expect(formatDuration(83)).toBe('1m 23s');
    expect(formatDuration(7440)).toBe('2h 04m');
  });
});

describe('useCopy', () => {
  it('copies text and reports transient copied state', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const { result } = renderHook(() => useCopy());
    expect(result.current.copied).toBe(false);

    await act(async () => {
      expect(await result.current.copy('secret')).toBe(true);
    });
    expect(writeText).toHaveBeenCalledWith('secret');
    expect(result.current.copied).toBe(true);

    await waitFor(() => expect(result.current.copied).toBe(false), { timeout: 2500 });
  });

  it('reports failure without flipping copied when the clipboard rejects', async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    const { result } = renderHook(() => useCopy());
    let ok = true;
    await act(async () => {
      ok = await result.current.copy('nope');
    });
    expect(ok).toBe(false);
    expect(result.current.copied).toBe(false);
  });
});

describe('downloadBlob', () => {
  it('triggers an anchor download and revokes the object URL (deferred)', () => {
    vi.useFakeTimers();
    const url = 'blob:mock-url';
    const revoke = vi.fn();
    const createObjectURL = vi.fn().mockReturnValue(url);
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL: revoke });

    const click = vi.fn();
    const anchor = document.createElement('a');
    anchor.click = click;
    const createElement = vi.spyOn(document, 'createElement').mockReturnValue(anchor);

    downloadBlob('{"a":1}', 'export.json', 'application/json');
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(anchor.download).toBe('export.json');
    expect(click).toHaveBeenCalledOnce();
    // Revocation is deferred (some browsers commit downloads asynchronously)
    // — fire the timer to reach it.
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(revoke).toHaveBeenCalledWith(url);

    createElement.mockRestore();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});
