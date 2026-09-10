import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AiSection } from '../src/routes/settings/AiSection.js';
import { api } from '../src/lib/api.js';
import { useAuth } from '../src/lib/auth.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

vi.mock('../src/lib/auth.js', async () => {
  const { createAuthMock } = await import('./apiMock.js');
  return createAuthMock();
});

vi.mock('../src/lib/workspace.js', async () => {
  const { createWorkspaceMock } = await import('./apiMock.js');
  return createWorkspaceMock();
});

vi.mock('../src/lib/theme.js', async () => {
  const { createThemeMock } = await import('./apiMock.js');
  return createThemeMock();
});

vi.mock('../src/lib/mode.js', async () => {
  const { createModeMock } = await import('./apiMock.js');
  return createModeMock();
});

vi.mock('../src/components/Toast.js', async () => {
  const React = await import('react');
  return {
    useToast: () => ({ toast: vi.fn() }),
    ToastProvider: ({ children }: { children?: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});

describe('AiSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOf(api.ai.getConfig).mockResolvedValue({ configured: false, baseUrl: null, model: null, hasApiKey: false });
    mockOf(useAuth).mockReturnValue({
      user: { id: 1, email: 'ada@example.com', name: 'Ada', isOperator: true },
      loading: false,
      login: vi.fn(),
      setup: vi.fn(),
      logout: vi.fn(),
    });
  });

  it('shows the unconfigured banner and defaults for a fresh setup', async () => {
    renderWithProviders(<AiSection />);
    expect(await screen.findByText(/Not configured/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Base URL/i)).toHaveValue('https://api.openai.com/v1');
    expect(screen.getByLabelText(/Model/i)).toHaveValue('gpt-4o-mini');
  });

  it('saves endpoint, model and key — then clears the key field', async () => {
    const updateSpy = vi.fn().mockResolvedValue({ ok: true });
    mockOf(api.ai.updateConfig).mockImplementation(updateSpy);
    renderWithProviders(<AiSection />);
    const user = userEvent.setup();
    await screen.findByText(/Not configured/);
    await user.clear(screen.getByLabelText(/Model/i));
    await user.type(screen.getByLabelText(/Model/i), 'llama3.1');
    await user.type(screen.getByLabelText(/API key/i), 'sk-local-12345678');
    await user.click(screen.getByRole('button', { name: /Save AI settings/ }));
    await waitFor(() =>
      expect(updateSpy).toHaveBeenCalledWith({ baseUrl: 'https://api.openai.com/v1', model: 'llama3.1', apiKey: 'sk-local-12345678' }),
    );
    expect(screen.getByLabelText(/API key/i)).toHaveValue('');
  });

  it('keeps the stored key when the field is left empty', async () => {
    mockOf(api.ai.getConfig).mockResolvedValue({
      configured: true,
      baseUrl: 'https://ai.example.com/v1',
      model: 'gpt-test',
      hasApiKey: true,
    });
    const updateSpy = vi.fn().mockResolvedValue({ ok: true });
    mockOf(api.ai.updateConfig).mockImplementation(updateSpy);
    renderWithProviders(<AiSection />);
    const user = userEvent.setup();
    await screen.findByText(/Configured — gpt-test/);
    await user.click(screen.getByRole('button', { name: /Save AI settings/ }));
    await waitFor(() => expect(updateSpy).toHaveBeenCalledWith({ baseUrl: 'https://ai.example.com/v1', model: 'gpt-test' }));
  });

  it('disables the form for non-operators', async () => {
    mockOf(useAuth).mockReturnValue({
      user: { id: 7, email: 'bob@example.com', name: 'Bob', isOperator: false },
      loading: false,
      login: vi.fn(),
      setup: vi.fn(),
      logout: vi.fn(),
    });
    renderWithProviders(<AiSection />);
    await screen.findByText(/Not configured/);
    expect(screen.getByLabelText(/Base URL/i)).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Save AI settings/ })).not.toBeInTheDocument();
  });
});
