import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LAYOUT, LAYOUT_STORAGE_KEY, readLayout, usePanelLayout, writeLayout } from '../src/lib/layout.js';

describe('A3 panel layout preference', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem(LAYOUT_STORAGE_KEY);
    writeLayout('classic');
    localStorage.removeItem(LAYOUT_STORAGE_KEY);
  });

  // N10: the comparison of the two layouts is done and compact is the default.
  it('N10: a browser that never chose gets the default, compact', () => {
    localStorage.removeItem(LAYOUT_STORAGE_KEY);
    expect(DEFAULT_LAYOUT).toBe('compact');
    expect(readLayout()).toBe('compact');
    const { result } = renderHook(() => usePanelLayout());
    expect(result.current).toMatchObject({ layout: 'compact', isCompact: true });
  });

  it('N10: an explicit Classic is kept exactly like an explicit Compact, and survives a reload', () => {
    localStorage.setItem(LAYOUT_STORAGE_KEY, 'classic');
    expect(readLayout()).toBe('classic');
    let { result, unmount } = renderHook(() => usePanelLayout());
    expect(result.current).toMatchObject({ layout: 'classic', isCompact: false });
    unmount();

    act(() => writeLayout('compact'));
    expect(localStorage.getItem(LAYOUT_STORAGE_KEY)).toBe('compact');
    expect(readLayout()).toBe('compact');
    ({ result, unmount } = renderHook(() => usePanelLayout()));
    expect(result.current).toMatchObject({ layout: 'compact', isCompact: true });
    unmount();

    // Back to Classic, as the Appearance switch does.
    act(() => writeLayout('classic'));
    expect(readLayout()).toBe('classic');
  });

  it('N10: tells every reader in this tab when the choice changes', () => {
    localStorage.removeItem(LAYOUT_STORAGE_KEY);
    const { result } = renderHook(() => usePanelLayout());
    act(() => result.current.setLayout('classic'));
    expect(result.current).toMatchObject({ layout: 'classic', isCompact: false });
    act(() => result.current.setLayout('compact'));
    expect(result.current).toMatchObject({ layout: 'compact', isCompact: true });
  });

  it('follows a change made in another tab', () => {
    const { result } = renderHook(() => usePanelLayout());
    localStorage.setItem(LAYOUT_STORAGE_KEY, 'compact');
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: LAYOUT_STORAGE_KEY })); });
    expect(result.current.isCompact).toBe(true);
  });

  it('reads the default when storage is blocked, and keeps a choice for the page when writes are refused', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(readLayout()).toBe(DEFAULT_LAYOUT);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    const { result } = renderHook(() => usePanelLayout());
    act(() => result.current.setLayout('classic'));
    expect(result.current.isCompact).toBe(false);
  });

  it('N10: an unknown stored value is not a choice', () => {
    localStorage.setItem(LAYOUT_STORAGE_KEY, 'something-else');
    expect(readLayout()).toBe('compact');
  });
});
