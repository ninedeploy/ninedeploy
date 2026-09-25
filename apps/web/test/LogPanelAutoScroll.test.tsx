import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const logs = vi.hoisted(() => ({ lines: 'line 1\n', open: true }));
vi.mock('../src/lib/useDeployLogs.js', () => ({ useDeployLogs: () => logs }));

import { LogPanel } from '../src/routes/service/LogPanel.js';

/** jsdom has no layout: give the <pre> a scroll geometry by hand. */
function geometry(el: HTMLElement, g: { scrollHeight: number; clientHeight: number }) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: g.scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: g.clientHeight });
}

describe('LogPanel auto-scroll (r212)', () => {
  it('keeps following when a flushed batch is taller than the slack', () => {
    const { container, rerender } = render(<LogPanel serviceId={1} deploymentId={2} deployStatus="building" />);
    const pre = container.querySelector('pre')!;
    // At the bottom of a 1000px log.
    geometry(pre, { scrollHeight: 1000, clientHeight: 100 });
    pre.scrollTop = 900;
    fireEvent.scroll(pre);
    // A 1000px burst lands in one flush.
    logs.lines = `${logs.lines}${'more\n'.repeat(50)}`;
    geometry(pre, { scrollHeight: 2000, clientHeight: 100 });
    rerender(<LogPanel serviceId={1} deploymentId={2} deployStatus="building" />);
    expect(pre.scrollTop).toBe(2000);
  });

  it('stays put when the user scrolled up to read', () => {
    logs.lines = 'line 1\n';
    const { container, rerender } = render(<LogPanel serviceId={1} deploymentId={2} deployStatus="building" />);
    const pre = container.querySelector('pre')!;
    geometry(pre, { scrollHeight: 1000, clientHeight: 100 });
    pre.scrollTop = 200;
    fireEvent.scroll(pre);
    logs.lines = `${logs.lines}next\n`;
    geometry(pre, { scrollHeight: 1020, clientHeight: 100 });
    rerender(<LogPanel serviceId={1} deploymentId={2} deployStatus="building" />);
    expect(pre.scrollTop).toBe(200);
  });

  it('lets the user scroll up when the panel first mounted with no deployment (r290)', () => {
    logs.lines = 'line 1\n';
    // First deploy / wizard hand-off / rollback: no deployment id yet, so
    // no <pre> is rendered on mount.
    const { container, rerender } = render(<LogPanel serviceId={1} deploymentId={null} />);
    expect(container.querySelector('pre')).toBeNull();
    rerender(<LogPanel serviceId={1} deploymentId={2} deployStatus="building" />);
    const pre = container.querySelector('pre')!;
    geometry(pre, { scrollHeight: 1000, clientHeight: 100 });
    pre.scrollTop = 200;
    fireEvent.scroll(pre);
    logs.lines = `${logs.lines}next\n`;
    geometry(pre, { scrollHeight: 1020, clientHeight: 100 });
    rerender(<LogPanel serviceId={1} deploymentId={2} deployStatus="building" />);
    expect(pre.scrollTop).toBe(200);
  });
});
