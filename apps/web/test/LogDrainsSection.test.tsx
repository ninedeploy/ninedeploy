import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LogDrainsSection } from '../src/routes/settings/LogDrainsSection.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

const toastSpy = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../src/components/Toast.js', () => ({
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useToast: () => toastSpy,
}));

describe('LogDrainsSection', () => {
  const fakeDrain = {
    id: 1,
    name: 'Datadog Prod',
    type: 'datadog' as const,
    url: 'https://http-intake.logs.datadoghq.com',
    hasApiKey: true,
    serviceId: null,
    serviceName: null,
    enabled: true,
    format: 'json' as const,
    createdAt: '2026-08-18T10:00:00Z',
    updatedAt: '2026-08-18T10:00:00Z',
  };

  const fakeServiceDrain = {
    id: 2,
    name: 'Scoped Loki',
    type: 'loki' as const,
    url: 'https://loki.example.com',
    hasApiKey: false,
    serviceId: 10,
    serviceName: 'Frontend Web',
    enabled: false,
    format: 'raw' as const,
    createdAt: '2026-08-18T10:00:00Z',
    updatedAt: '2026-08-18T10:00:00Z',
  };

  const fakeService = {
    id: 10,
    name: 'Frontend Web',
    slug: 'web',
    type: 'docker',
    status: 'running',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    toastSpy.toast.mockClear();
    mockOf(api.logDrains.list).mockResolvedValue([fakeDrain, fakeServiceDrain] as never);
    mockOf(api.services.list).mockResolvedValue([fakeService] as never);
    mockOf(api.logDrains.create).mockResolvedValue({ ...fakeDrain, id: 3, name: 'Vector Sink' } as never);
    mockOf(api.logDrains.update).mockResolvedValue({ ...fakeDrain, enabled: false } as never);
    mockOf(api.logDrains.remove).mockResolvedValue({ ok: true } as never);
    mockOf(api.logDrains.test).mockResolvedValue({ ok: true, latencyMs: 42, message: 'HTTP 200 OK' } as never);
  });

  it('renders log drains list with sink details and service scope', async () => {
    renderWithProviders(<LogDrainsSection />);

    await waitFor(() => {
      expect(screen.getByText('Datadog Prod')).toBeInTheDocument();
      expect(screen.getByText('Scoped Loki')).toBeInTheDocument();
    });

    expect(screen.getByText('datadog')).toBeInTheDocument();
    expect(screen.getByText('Global')).toBeInTheDocument();
    expect(screen.getByText('Frontend Web')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Disabled')).toBeInTheDocument();
  });

  it('renders empty state, opens modal, and closes via close button and cancel', async () => {
    mockOf(api.logDrains.list).mockResolvedValueOnce([] as never);
    renderWithProviders(<LogDrainsSection />);

    await waitFor(() => {
      expect(screen.getByText('No external log drains configured')).toBeInTheDocument();
    });

    const addFirstBtn = screen.getByText('Add First Log Drain');
    fireEvent.click(addFirstBtn);

    expect(await screen.findByText('Add Log Drain Sink')).toBeInTheDocument();

    // Close via header close icon
    const closeBtns = screen.getAllByLabelText('Close dialog');
    fireEvent.click(closeBtns[1] || closeBtns[0]!);

    await waitFor(() => {
      expect(screen.queryByText('Add Log Drain Sink')).not.toBeInTheDocument();
    });

    // Reopen and close via Cancel button
    fireEvent.click(screen.getByText('Add First Log Drain'));
    expect(await screen.findByText('Add Log Drain Sink')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => {
      expect(screen.queryByText('Add Log Drain Sink')).not.toBeInTheDocument();
    });
  });

  it('opens add drain modal, fills full form, changes format and apiKey, and submits create', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LogDrainsSection />);

    await waitFor(() => expect(screen.getByText('Add Log Drain')).toBeInTheDocument());
    await user.click(screen.getByText('Add Log Drain'));

    expect(await screen.findByText('Add Log Drain Sink')).toBeInTheDocument();

    // Submit with empty fields (early return branch)
    const form = screen.getByRole('dialog').querySelector('form')!;
    fireEvent.submit(form);
    expect(api.logDrains.create).not.toHaveBeenCalled();

    // Fill form
    const nameInput = screen.getByPlaceholderText('e.g. Production Loki, Datadog US1');
    const urlInput = screen.getByPlaceholderText('https://loki.example.com/loki/api/v1/push');
    const apiKeyInput = screen.getByPlaceholderText('Bearer token or Datadog API Key');

    fireEvent.change(nameInput, { target: { value: 'Vector Sink' } });
    fireEvent.change(urlInput, { target: { value: 'https://vector.example.com' } });
    fireEvent.change(apiKeyInput, { target: { value: 'secret-token' } });

    // Change sink type to vector
    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[0]!, { target: { value: 'vector' } });

    // Change format explicitly to raw
    fireEvent.change(selects[1]!, { target: { value: 'raw' } });

    // Scope to service then back to global empty string
    fireEvent.change(selects[2]!, { target: { value: '10' } });
    fireEvent.change(selects[2]!, { target: { value: '' } });

    // Submit form
    await user.click(screen.getByText('Save Log Drain'));

    await waitFor(() => {
      expect(api.logDrains.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Vector Sink',
          type: 'vector',
          url: 'https://vector.example.com',
          apiKey: ['secret', 'token'].join('-'),
          format: 'raw',
          serviceId: undefined,
        }),
      );
      expect(toastSpy.toast).toHaveBeenCalledWith('Log drain destination created', 'success');
    });
  });

  it('tests connection and shows success probe toast', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LogDrainsSection />);

    await waitFor(() => expect(screen.getAllByText('Test Connection')[0]).toBeInTheDocument());
    await user.click(screen.getAllByText('Test Connection')[0]!);

    await waitFor(() => {
      expect(api.logDrains.test).toHaveBeenCalledWith(1);
      expect(toastSpy.toast).toHaveBeenCalledWith(expect.stringContaining('Probe successful (42ms)'), 'success');
    });
  });

  it('tests connection and handles probe failure or network error', async () => {
    const user = userEvent.setup();
    mockOf(api.logDrains.test).mockResolvedValueOnce({ ok: false, latencyMs: 150, message: 'HTTP 401 Unauthorized' } as never);
    renderWithProviders(<LogDrainsSection />);

    await waitFor(() => expect(screen.getAllByText('Test Connection')[0]).toBeInTheDocument());
    await user.click(screen.getAllByText('Test Connection')[0]!);

    await waitFor(() => {
      expect(toastSpy.toast).toHaveBeenCalledWith('Probe failed: HTTP 401 Unauthorized', 'error');
    });

    // Network error
    mockOf(api.logDrains.test).mockRejectedValueOnce(new Error('Network error'));
    await user.click(screen.getAllByText('Test Connection')[0]!);
    await waitFor(() => {
      expect(toastSpy.toast).toHaveBeenCalledWith('Failed to test log drain connection', 'error');
    });
  });

  it('toggles drain active status and handles mutation failure', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LogDrainsSection />);

    await waitFor(() => expect(screen.getByText('Active')).toBeInTheDocument());
    await user.click(screen.getByText('Active'));

    await waitFor(() => {
      expect(api.logDrains.update).toHaveBeenCalledWith(1, { enabled: false });
      expect(toastSpy.toast).toHaveBeenCalledWith('Log drain status updated', 'success');
    });

    // Error branch
    mockOf(api.logDrains.update).mockRejectedValueOnce(new Error('Update failed'));
    await user.click(screen.getByText('Disabled'));
    await waitFor(() => {
      expect(toastSpy.toast).toHaveBeenCalledWith('Failed to update log drain', 'error');
    });
  });

  it('deletes log drain on confirm and handles rejection or error', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('confirm', vi.fn(() => false));
    renderWithProviders(<LogDrainsSection />);

    await waitFor(() => expect(screen.getAllByTitle('Delete log drain')[0]).toBeInTheDocument());
    await user.click(screen.getAllByTitle('Delete log drain')[0]!);
    expect(api.logDrains.remove).not.toHaveBeenCalled();

    // Confirm true
    vi.stubGlobal('confirm', vi.fn(() => true));
    await user.click(screen.getAllByTitle('Delete log drain')[0]!);

    await waitFor(() => {
      expect(api.logDrains.remove).toHaveBeenCalledWith(1);
      expect(toastSpy.toast).toHaveBeenCalledWith('Log drain removed', 'success');
    });

    // Error branch
    mockOf(api.logDrains.remove).mockRejectedValueOnce(new Error('Delete failed'));
    await user.click(screen.getAllByTitle('Delete log drain')[0]!);
    await waitFor(() => {
      expect(toastSpy.toast).toHaveBeenCalledWith('Failed to remove log drain', 'error');
    });
  });

  it('handles create mutation error', async () => {
    const user = userEvent.setup();
    mockOf(api.logDrains.create).mockRejectedValueOnce(new Error('Creation failed'));
    renderWithProviders(<LogDrainsSection />);

    await waitFor(() => expect(screen.getByText('Add Log Drain')).toBeInTheDocument());
    await user.click(screen.getByText('Add Log Drain'));

    expect(await screen.findByText('Add Log Drain Sink')).toBeInTheDocument();

    const nameInput = screen.getByPlaceholderText('e.g. Production Loki, Datadog US1');
    const urlInput = screen.getByPlaceholderText('https://loki.example.com/loki/api/v1/push');

    fireEvent.change(nameInput, { target: { value: 'Err Sink' } });
    fireEvent.change(urlInput, { target: { value: 'https://err.example.com' } });

    await user.click(screen.getByText('Save Log Drain'));

    await waitFor(() => {
      expect(toastSpy.toast).toHaveBeenCalledWith('Failed to create log drain destination', 'error');
    });
  });
});
