import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LAYOUT_STORAGE_KEY, readLayout, usePanelLayout, writeLayout } from '../src/lib/layout.js';

describe('A3 panel layout preference', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem(LAYOUT_STORAGE_KEY);
    writeLayout('classic');
    localStorage.removeItem(LAYOUT_STORAGE_KEY);
  });

  it('defaults to classic, stores compact, and tells every reader in this tab', () => {
    const { result } = renderHook(() => usePanelLayout());
    expect(result.current).toMatchObject({ layout: 'classic', isCompact: false });
    act(() => result.current.setLayout('compact'));
    expect(result.current).toMatchObject({ layout: 'compact', isCompact: true });
    expect(localStorage.getItem(LAYOUT_STORAGE_KEY)).toBe('compact');
  });

  it('follows a change made in another tab', () => {
    const { result } = renderHook(() => usePanelLayout());
    localStorage.setItem(LAYOUT_STORAGE_KEY, 'compact');
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: LAYOUT_STORAGE_KEY })); });
    expect(result.current.isCompact).toBe(true);
  });

  it('reads classic when storage is blocked, and keeps a choice for the page when writes are refused', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(readLayout()).toBe('classic');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    const { result } = renderHook(() => usePanelLayout());
    act(() => result.current.setLayout('compact'));
    expect(result.current.isCompact).toBe(true);
  });
});
