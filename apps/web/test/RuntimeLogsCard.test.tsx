import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** 0.16.3 runtime logs: search with highlights, line count, pause and download. */

const apiMock = vi.hoisted(() => ({
  api: { services: { logs: vi.fn() }, ai: { getConfig: vi.fn(), analyzeLogs: vi.fn() } },
}));
vi.mock('../src/lib/api.js', () => apiMock);
const toastSpy = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../src/components/Toast.js', () => ({ useToast: () => toastSpy }));

const formatMock = vi.hoisted(() => ({ downloadBlob: vi.fn() }));
vi.mock('../src/lib/format.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/format.js')>()),
  downloadBlob: formatMock.downloadBlob,
}));

import { RuntimeLogsCard } from '../src/routes/service/RuntimeLogsCard.js';

const LINES = '2026-10-18T10:00:00Z GET /health 200\n2026-10-18T10:00:01Z ERROR db timeout\n2026-10-18T10:00:02Z error: retry db';

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RuntimeLogsCard serviceId={4} slug="api" />
    </QueryClientProvider>,
  );
}
const pre = () => document.querySelector('pre')!;

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.api.services.logs.mockResolvedValue({ lines: LINES });
  apiMock.api.ai.getConfig.mockResolvedValue({ configured: false, baseUrl: null, model: null, hasApiKey: false });
});

describe('RuntimeLogsCard', () => {
  it('shows every line, then only the lines that match the search (case-insensitive), with the matches marked', async () => {
    renderCard();
    await waitFor(() => expect(pre().textContent).toBe(LINES));
    expect(apiMock.api.services.logs).toHaveBeenCalledWith(4, undefined);
    expect(screen.getByText(/^3 lines/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Search logs'), { target: { value: 'Error' } });
    expect(pre().textContent).toBe('2026-10-18T10:00:01Z ERROR db timeout\n2026-10-18T10:00:02Z error: retry db');
    expect([...pre().querySelectorAll('mark')].map((m) => m.textContent)).toEqual(['ERROR', 'error']);
    expect(screen.getByText(/2 of 3 lines match/)).toBeInTheDocument();

    // Every occurrence in a line is marked.
    fireEvent.change(screen.getByLabelText('Search logs'), { target: { value: 'db' } });
    expect(pre().querySelectorAll('mark')).toHaveLength(2);

    fireEvent.change(screen.getByLabelText('Search logs'), { target: { value: 'nothing-like-this' } });
    expect(pre().textContent).toBe('No line matches.');
  });

  it('asks the server for more lines', async () => {
    renderCard();
    await waitFor(() => expect(apiMock.api.services.logs).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('Lines'), { target: { value: '5000' } });
    await waitFor(() => expect(apiMock.api.services.logs).toHaveBeenCalledWith(4, { tail: 5000 }));
  });

  it('downloads the loaded lines, not just the matches', async () => {
    renderCard();
    await waitFor(() => expect(pre().textContent).toBe(LINES));
    fireEvent.change(screen.getByLabelText('Search logs'), { target: { value: 'error' } });
    fireEvent.click(screen.getByRole('button', { name: 'Download logs' }));
    expect(formatMock.downloadBlob).toHaveBeenCalledWith(LINES, 'api-runtime.log', 'text/plain');
  });

  it('pauses and resumes the live refresh', async () => {
    renderCard();
    await waitFor(() => expect(pre().textContent).toBe(LINES));
    fireEvent.click(screen.getByRole('button', { name: 'Pause live logs' }));
    expect(screen.getByText(/paused/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resume live logs' }));
    expect(screen.getByText(/live · refreshed every 3 s/)).toBeInTheDocument();
  });

  it('empty logs: a placeholder, and nothing to download', async () => {
    apiMock.api.services.logs.mockResolvedValue({ lines: '' });
    renderCard();
    await waitFor(() => expect(apiMock.api.services.logs).toHaveBeenCalled());
    expect(pre().textContent).toBe('No logs yet.');
    expect(screen.getByRole('button', { name: 'Download logs' })).toBeDisabled();
  });

  it('follows new output only while the reader is at the bottom', async () => {
    renderCard();
    await waitFor(() => expect(pre().textContent).toBe(LINES));
    const el = pre();
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: 200 });
    el.scrollTop = 100;
    fireEvent.scroll(el);
    fireEvent.change(screen.getByLabelText('Search logs'), { target: { value: 'db' } });
    expect(el.scrollTop).toBe(100);
    el.scrollTop = 790;
    fireEvent.scroll(el);
    fireEvent.change(screen.getByLabelText('Search logs'), { target: { value: '' } });
    expect(el.scrollTop).toBe(1000);
  });

  it('0.16.15: offers no analysis without an AI provider', async () => {
    renderCard();
    await waitFor(() => expect(pre().textContent).toBe(LINES));
    expect(screen.queryByLabelText('Analyze logs with AI')).not.toBeInTheDocument();
  });

  it('0.16.15: analyzes the lines on screen with the configured provider, and closes the answer', async () => {
    apiMock.api.ai.getConfig.mockResolvedValue({ configured: true, provider: 'anthropic', baseUrl: null, model: 'claude-sonnet-5-5', hasApiKey: true });
    apiMock.api.ai.analyzeLogs.mockResolvedValue({ analysis: 'Health: degraded. Problems: db timeout.', model: 'claude-sonnet-5-5', lines: 3 });
    renderCard();
    fireEvent.click(await screen.findByLabelText('Analyze logs with AI'));
    expect(await screen.findByText('Health: degraded. Problems: db timeout.')).toBeInTheDocument();
    expect(apiMock.api.ai.analyzeLogs).toHaveBeenCalledWith(4, { tail: 300 });
    expect(screen.getByText(/AI analysis of the last 3 lines · claude-sonnet-5-5/)).toBeInTheDocument();
    // The log itself is still the first <pre>.
    expect(pre().textContent).toBe(LINES);
    fireEvent.click(screen.getByLabelText('Close the analysis'));
    expect(screen.queryByText(/AI analysis of the last/)).not.toBeInTheDocument();
  });

  it('0.16.15: says why an analysis failed', async () => {
    apiMock.api.ai.getConfig.mockResolvedValue({ configured: true, baseUrl: null, model: 'm', hasApiKey: true });
    apiMock.api.ai.analyzeLogs.mockRejectedValueOnce(new Error('The AI provider timed out.')).mockRejectedValueOnce('nope');
    renderCard();
    fireEvent.click(await screen.findByLabelText('Analyze logs with AI'));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('The AI provider timed out.', 'error'));
    await waitFor(() => expect(screen.getByLabelText('Analyze logs with AI')).not.toBeDisabled());
    fireEvent.click(screen.getByLabelText('Analyze logs with AI'));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Analysis failed', 'error'));
  });
});
