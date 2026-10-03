import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppErrorBoundary } from '../src/components/AppErrorBoundary.js';

function Broken(): never {
  throw new Error('render failed');
}

describe('AppErrorBoundary', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders a recovery screen and reload action after a child crash', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    render(<AppErrorBoundary><Broken /></AppErrorBoundary>);
    expect(screen.getByText('NineDeploy could not render this page')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reload dashboard' }));
    expect(reload).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
});
