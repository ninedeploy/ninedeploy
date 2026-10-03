import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import './web-utils.js';
import { ToastProvider, useToast } from '../src/components/Toast.js';

function Trigger() {
  const { toast } = useToast();
  return (
    <div>
      <button type="button" onClick={() => toast('Saved!', 'success')}>success</button>
      <button type="button" onClick={() => toast('Boom', 'error')}>error</button>
      <button type="button" onClick={() => toast('Heads up', 'info')}>info</button>
      <button type="button" onClick={() => toast('Default type')}>default</button>
    </div>
  );
}

function renderToast() {
  return render(
    <ToastProvider>
      <Trigger />
    </ToastProvider>,
  );
}

describe('ToastProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders a success toast with the message', () => {
    renderToast();
    fireEvent.click(screen.getByText('success'));
    expect(screen.getByText('Saved!')).toBeInTheDocument();
  });

  it('renders error and info toasts with distinct styles', () => {
    renderToast();
    fireEvent.click(screen.getByText('error'));
    fireEvent.click(screen.getByText('info'));
    expect(screen.getByText('Boom').closest('div')).toHaveClass('border-rose-500/30');
    expect(screen.getByText('Heads up').closest('div')).toHaveClass('border-indigo-500/30');
  });

  it('defaults the type to info', () => {
    renderToast();
    fireEvent.click(screen.getByText('default'));
    expect(screen.getByText('Default type').closest('div')).toHaveClass('border-indigo-500/30');
  });

  it('stacks multiple toasts', () => {
    renderToast();
    fireEvent.click(screen.getByText('success'));
    fireEvent.click(screen.getByText('error'));
    expect(screen.getByText('Saved!')).toBeInTheDocument();
    expect(screen.getByText('Boom')).toBeInTheDocument();
  });

  it('dismisses a toast when its close button is clicked', () => {
    renderToast();
    fireEvent.click(screen.getByText('success'));
    const toastEl = screen.getByText('Saved!');
    const dismiss = toastEl.parentElement?.querySelector('button');
    expect(dismiss).not.toBeNull();
    fireEvent.click(dismiss as HTMLButtonElement);
    expect(screen.queryByText('Saved!')).not.toBeInTheDocument();
  });

  it('auto-dismisses a toast after 4 seconds', () => {
    renderToast();
    fireEvent.click(screen.getByText('success'));
    expect(screen.getByText('Saved!')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(4000));
    expect(screen.queryByText('Saved!')).not.toBeInTheDocument();
  });

  it('exposes the toaster as an aria-live region for screen readers', () => {
    renderToast();
    // The toaster container announces added/removed toasts (role="status" +
    // aria-live="polite") so failures are not silent to assistive tech.
    const region = document.querySelector('[role="status"][aria-live="polite"]');
    expect(region).not.toBeNull();
    expect(region).toBeInTheDocument();
  });

  it('does not auto-dismiss before the timeout elapses', () => {
    renderToast();
    fireEvent.click(screen.getByText('success'));
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.getByText('Saved!')).toBeInTheDocument();
  });
});

describe('useToast', () => {
  it('falls back to a no-op context outside a ToastProvider (never throws)', () => {
    const original = console.error;
    console.error = vi.fn();
    try {
      // useToast returns a no-op fallback instead of throwing, so rendering
      // outside the provider must not blow up.
      render(<Trigger />);
      expect(screen.getAllByRole('button').length).toBe(4);
    } finally {
      console.error = original;
    }
  });
});
