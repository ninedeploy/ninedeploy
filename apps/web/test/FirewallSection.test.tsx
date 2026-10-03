import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import './web-utils.js';
import { renderWithProviders } from './web-utils.js';
import { FirewallSection, ufwRuleMatchesPort } from '../src/routes/settings/FirewallSection.js';

const apiMock = vi.hoisted(() => ({
  api: {
    firewall: {
      status: vi.fn(),
      toggle: vi.fn(),
      addRule: vi.fn(),
      deleteRule: vi.fn(),
      applyRecommended: vi.fn(),
    },
  },
}));
vi.mock('../src/lib/api.js', () => apiMock);

const toastSpy = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../src/components/Toast.js', () => ({
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useToast: () => toastSpy,
}));

describe('FirewallSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    toastSpy.toast.mockClear();
  });

  it('renders installed active firewall status with active rules', async () => {
    apiMock.api.firewall.status.mockResolvedValue({
      installed: true,
      active: true,
      supported: true,
      rules: [
        { id: 1, to: '22/tcp', action: 'ALLOW IN', from: 'Anywhere', comment: 'SSH' },
        { id: 2, to: '80/tcp', action: 'ALLOW IN', from: 'Anywhere', comment: 'HTTP' },
        { id: 3, to: '443/tcp', action: 'ALLOW IN', from: 'Anywhere', comment: 'HTTPS' },
        { id: 4, to: '25/tcp', action: 'DENY IN', from: '10.0.0.1', comment: '' },
      ],
      defaultIncoming: 'deny',
      defaultOutgoing: 'allow',
    });

    renderWithProviders(<FirewallSection />);

    expect(await screen.findByText('Active & Enforcing')).toBeInTheDocument();
    expect(screen.getByText('4 rule(s)')).toBeInTheDocument();
    expect(screen.getByText('22/tcp')).toBeInTheDocument();
    expect(screen.getByText('80/tcp')).toBeInTheDocument();
    expect(screen.getByText('443/tcp')).toBeInTheDocument();
    expect(screen.getByText('DENY IN')).toBeInTheDocument();
  });

  it('renders inactive firewall and allows enabling it and applying VPS profile', async () => {
    apiMock.api.firewall.status.mockResolvedValue({
      installed: true,
      active: false,
      supported: true,
      rules: [],
      defaultIncoming: 'allow',
      defaultOutgoing: 'allow',
    });

    apiMock.api.firewall.toggle.mockResolvedValue({
      ok: true,
      status: {
        installed: true,
        active: true,
        supported: true,
        rules: [],
        defaultIncoming: 'deny',
        defaultOutgoing: 'allow',
      },
    });

    apiMock.api.firewall.applyRecommended.mockResolvedValue({
      ok: true,
      status: {
        installed: true,
        active: true,
        supported: true,
        rules: [
          { id: 1, to: '22/tcp', action: 'ALLOW IN', from: 'Anywhere' },
          { id: 2, to: '80/tcp', action: 'ALLOW IN', from: 'Anywhere' },
          { id: 3, to: '443/tcp', action: 'ALLOW IN', from: 'Anywhere' },
        ],
        defaultIncoming: 'deny',
        defaultOutgoing: 'allow',
      },
    });

    renderWithProviders(<FirewallSection />);

    expect(await screen.findByText('Inactive')).toBeInTheDocument();
    expect(screen.getByText('No active host firewall rules configured.')).toBeInTheDocument();

    // Enable firewall
    const enableBtn = screen.getByRole('button', { name: 'Enable Firewall' });
    fireEvent.click(enableBtn);
    await waitFor(() => {
      expect(apiMock.api.firewall.toggle).toHaveBeenCalledWith(true);
      expect(toastSpy.toast).toHaveBeenCalledWith('Host firewall (UFW) enabled', 'success');
    });

    // Apply VPS profile
    const vpsBtn = screen.getByRole('button', { name: 'Apply VPS Profile' });
    fireEvent.click(vpsBtn);
    await waitFor(() => {
      expect(apiMock.api.firewall.applyRecommended).toHaveBeenCalled();
      expect(toastSpy.toast).toHaveBeenCalledWith(
        'Recommended VPS firewall profile applied (22, 80, 443 allowed)',
        'success',
      );
    });
  });

  it('renders not installed state when UFW is absent', async () => {
    apiMock.api.firewall.status.mockResolvedValue({
      installed: false,
      active: false,
      supported: false,
      rules: [],
      defaultIncoming: 'unknown',
      defaultOutgoing: 'unknown',
    });

    renderWithProviders(<FirewallSection />);

    expect(await screen.findByText('Not Installed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enable Firewall' })).not.toBeInTheDocument();
  });

  it('r191: matches UFW "To" columns on the exact port, v6 twins included', () => {
    expect(ufwRuleMatchesPort('22/tcp', 22, 'tcp')).toBe(true);
    expect(ufwRuleMatchesPort('22/tcp (v6)', 22, 'tcp')).toBe(true);
    expect(ufwRuleMatchesPort('2222/tcp', 22, 'tcp')).toBe(false);
    expect(ufwRuleMatchesPort('80', 80, 'tcp')).toBe(true);
    expect(ufwRuleMatchesPort('80/udp', 80, 'tcp')).toBe(false);
    expect(ufwRuleMatchesPort('8000:8100/tcp', 8080, 'tcp')).toBe(true);
  });

  it('r191: closing a preset deletes every matching rule highest-id first (ufw renumbers)', async () => {
    apiMock.api.firewall.status.mockResolvedValue({
      installed: true,
      active: true,
      supported: true,
      rules: [
        { id: 1, to: '22/tcp', action: 'ALLOW IN', from: 'Anywhere', comment: 'SSH' },
        { id: 2, to: '80/tcp', action: 'ALLOW IN', from: 'Anywhere' },
        { id: 3, to: '443/tcp', action: 'ALLOW IN', from: 'Anywhere' },
        { id: 4, to: '22/tcp (v6)', action: 'ALLOW IN', from: 'Anywhere (v6)' },
        { id: 5, to: '80/tcp (v6)', action: 'ALLOW IN', from: 'Anywhere (v6)' },
        { id: 6, to: '443/tcp (v6)', action: 'ALLOW IN', from: 'Anywhere (v6)' },
      ],
      defaultIncoming: 'deny',
      defaultOutgoing: 'allow',
    });
    apiMock.api.firewall.deleteRule.mockResolvedValue({ ok: true });
    renderWithProviders(<FirewallSection />);
    expect(await screen.findByText('Active & Enforcing')).toBeInTheDocument();
    // The first preset is the web ingress one (80, 443).
    fireEvent.click(screen.getAllByRole('button', { name: 'Close Ports' })[0]!);
    await waitFor(() => expect(apiMock.api.firewall.deleteRule).toHaveBeenCalledTimes(4));
    expect(apiMock.api.firewall.deleteRule.mock.calls.map((c) => c[0])).toEqual([6, 5, 3, 2]);
  });

  it('allows opening and closing 1-click presets', async () => {
    apiMock.api.firewall.status.mockResolvedValue({
      installed: true,
      active: true,
      supported: true,
      rules: [{ id: 10, to: '22/tcp', action: 'ALLOW IN', from: 'Anywhere', comment: 'SSH' }],
      defaultIncoming: 'deny',
      defaultOutgoing: 'allow',
    });

    apiMock.api.firewall.addRule.mockResolvedValue({
      ok: true,
      status: {
        installed: true,
        active: true,
        supported: true,
        rules: [],
        defaultIncoming: 'deny',
        defaultOutgoing: 'allow',
      },
    });

    apiMock.api.firewall.deleteRule.mockResolvedValue({
      ok: true,
      status: {
        installed: true,
        active: true,
        supported: true,
        rules: [],
        defaultIncoming: 'deny',
        defaultOutgoing: 'allow',
      },
    });

    renderWithProviders(<FirewallSection />);

    expect(await screen.findByText('Active & Enforcing')).toBeInTheDocument();
    expect(screen.getByText('1-Click Service Port Presets')).toBeInTheDocument();

    // SSH is currently open in rule id 10 -> shows "Close Ports"
    const sshCloseBtn = screen.getAllByRole('button', { name: 'Close Ports' })[0]!;
    fireEvent.click(sshCloseBtn);
    await waitFor(() => {
      expect(apiMock.api.firewall.deleteRule).toHaveBeenCalledWith(10);
      expect(toastSpy.toast).toHaveBeenCalledWith('Closed ports for SSH Remote Console', 'success');
    });

    // PostgreSQL is closed -> click "Open All Ports"
    const openBtns = screen.getAllByRole('button', { name: 'Open All Ports' });
    fireEvent.click(openBtns[0]!); // Web Ingress preset (80, 443)
    await waitFor(() => {
      expect(apiMock.api.firewall.addRule).toHaveBeenCalled();
    });
  });

  it('handles togglePreset failure gracefully', async () => {
    apiMock.api.firewall.status.mockResolvedValue({
      installed: true,
      active: true,
      supported: true,
      rules: [],
      defaultIncoming: 'deny',
      defaultOutgoing: 'allow',
    });

    apiMock.api.firewall.addRule.mockRejectedValue(new Error('UFW command failed'));

    renderWithProviders(<FirewallSection />);

    expect(await screen.findByText('Active & Enforcing')).toBeInTheDocument();
    expect(screen.getByText('1-Click Service Port Presets')).toBeInTheDocument();

    const openBtns = screen.getAllByRole('button', { name: 'Open All Ports' });
    fireEvent.click(openBtns[0]!);
    await waitFor(() => {
      expect(toastSpy.toast).toHaveBeenCalledWith('UFW command failed', 'error');
    });
  });

  it('submits custom port rule form with protocol, action, source IP and deletes rules', async () => {
    apiMock.api.firewall.status.mockResolvedValue({
      installed: true,
      active: true,
      supported: true,
      rules: [{ id: 99, to: '8080/tcp', action: 'ALLOW IN', from: '1.2.3.4', comment: 'Custom' }],
      defaultIncoming: 'deny',
      defaultOutgoing: 'allow',
    });

    apiMock.api.firewall.addRule.mockResolvedValue({
      ok: true,
      status: {
        installed: true,
        active: true,
        supported: true,
        rules: [{ id: 100, to: '3000/udp', action: 'DENY IN', from: '192.168.1.1' }],
        defaultIncoming: 'deny',
        defaultOutgoing: 'allow',
      },
    });

    apiMock.api.firewall.deleteRule.mockResolvedValue({
      ok: true,
      status: {
        installed: true,
        active: true,
        supported: true,
        rules: [],
        defaultIncoming: 'deny',
        defaultOutgoing: 'allow',
      },
    });

    renderWithProviders(<FirewallSection />);

    expect(await screen.findByText('8080/tcp')).toBeInTheDocument();

    // Delete existing rule 99 first
    const deleteBtn = screen.getByTitle('Delete rule');
    fireEvent.click(deleteBtn);
    await waitFor(() => {
      expect(apiMock.api.firewall.deleteRule).toHaveBeenCalledWith(99);
      expect(toastSpy.toast).toHaveBeenCalledWith('Firewall rule removed', 'success');
    });

    const portInput = screen.getByPlaceholderText('e.g. 8080, 25565');
    const sourceInput = screen.getByPlaceholderText('Anywhere (or 1.2.3.4)');

    fireEvent.change(portInput, { target: { value: '3000' } });
    fireEvent.change(sourceInput, { target: { value: '192.168.1.1' } });

    // Select UDP protocol
    const protoSelect = screen.getAllByRole('combobox')[0]!;
    fireEvent.change(protoSelect, { target: { value: 'udp' } });

    // Select DENY action
    const actionSelect = screen.getAllByRole('combobox')[1]!;
    fireEvent.change(actionSelect, { target: { value: 'deny' } });

    const submitBtn = screen.getByRole('button', { name: 'Open Port' });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(apiMock.api.firewall.addRule).toHaveBeenCalledWith({
        port: '3000',
        proto: 'udp',
        action: 'deny',
        from: '192.168.1.1',
        comment: undefined,
      });
      expect(toastSpy.toast).toHaveBeenCalledWith('Firewall port rule opened', 'success');
    });
  });

  it('handles errors for toggle, applyRecommended, addRule, and deleteRule', async () => {
    apiMock.api.firewall.status.mockResolvedValue({
      installed: true,
      active: true,
      supported: true,
      rules: [{ id: 7, to: '80/tcp', action: 'ALLOW IN', from: 'Anywhere' }],
      defaultIncoming: 'deny',
      defaultOutgoing: 'allow',
    });

    apiMock.api.firewall.toggle.mockRejectedValue(new Error('Toggle failed'));
    apiMock.api.firewall.deleteRule.mockRejectedValue(new Error('Delete failed'));

    renderWithProviders(<FirewallSection />);

    expect(await screen.findByText('80/tcp')).toBeInTheDocument();

    const disableBtn = screen.getByRole('button', { name: 'Disable Firewall' });
    fireEvent.click(disableBtn);
    await waitFor(() => {
      expect(toastSpy.toast).toHaveBeenCalledWith('Toggle failed', 'error');
    });

    const deleteBtn = screen.getByTitle('Delete rule');
    fireEvent.click(deleteBtn);
    await waitFor(() => {
      expect(toastSpy.toast).toHaveBeenCalledWith('Delete failed', 'error');
    });
  });

  it('covers success/fallback arms for toggle, presets and rule form', async () => {
    const statusPayload = {
      installed: true,
      active: true,
      supported: true,
      rules: [
        { id: 1, to: '22/tcp', action: 'ALLOW IN', from: 'Anywhere' },
        // Non-ALLOW and bare-port rules exercise the port-permission helper.
        { id: 2, to: '53', action: 'DENY IN', from: 'Anywhere' },
        { id: 3, to: '8080', action: 'ALLOW IN', from: 'Anywhere' },
      ],
      defaultIncoming: 'deny',
      defaultOutgoing: 'allow',
    };
    apiMock.api.firewall.status.mockResolvedValue(statusPayload);

    renderWithProviders(<FirewallSection />);
    expect(await screen.findByText('22/tcp')).toBeInTheDocument();

    // A successful disable toasts the disabled variant and flips the button.
    apiMock.api.firewall.toggle.mockResolvedValueOnce({ status: { ...statusPayload, active: false } });
    fireEvent.click(screen.getByRole('button', { name: 'Disable Firewall' }));
    await waitFor(() =>
      expect(toastSpy.toast).toHaveBeenCalledWith('Host firewall (UFW) disabled', 'success'));

    // Non-Error rejections fall back to the generic messages.
    apiMock.api.firewall.toggle.mockRejectedValueOnce(undefined as never);
    fireEvent.click(screen.getByRole('button', { name: 'Enable Firewall' }));
    await waitFor(() =>
      expect(toastSpy.toast).toHaveBeenCalledWith('Could not toggle firewall', 'error'), { timeout: 3000 });

    apiMock.api.firewall.applyRecommended.mockRejectedValueOnce('x' as never);
    fireEvent.click(screen.getByRole('button', { name: /apply vps profile/i }));
    await waitFor(() =>
      expect(toastSpy.toast).toHaveBeenCalledWith('Failed to apply recommended profile', 'error'));

    // The custom rule form submits a valid port.
    apiMock.api.firewall.addRule.mockResolvedValueOnce({ status: statusPayload });
    fireEvent.change(screen.getByPlaceholderText('e.g. 8080, 25565'), { target: { value: '8443' } });
    fireEvent.submit(screen.getByPlaceholderText('e.g. 8080, 25565').closest('form')!);
    await waitFor(() => expect(apiMock.api.firewall.addRule).toHaveBeenCalled());

    // A failing preset close surfaces the generic preset message.
    apiMock.api.firewall.deleteRule.mockRejectedValueOnce('nope' as never);
    fireEvent.click(screen.getAllByRole('button', { name: 'Close Ports' })[0]!);
    await waitFor(() =>
      expect(toastSpy.toast).toHaveBeenCalledWith('Failed to toggle port preset', 'error'));

    // Direct rule deletion and custom-rule creation fall back to their
    // generic messages for non-Error rejections.
    const confirmMock = vi.spyOn(window, 'confirm').mockReturnValue(true);
    apiMock.api.firewall.deleteRule.mockRejectedValueOnce(undefined as never);
    fireEvent.click(screen.getAllByTitle('Delete rule')[0]!);
    await waitFor(() =>
      expect(toastSpy.toast).toHaveBeenCalledWith('Failed to delete rule', 'error'));

    apiMock.api.firewall.addRule.mockRejectedValueOnce('bad' as never);
    fireEvent.change(screen.getByPlaceholderText('e.g. 8080, 25565'), { target: { value: '9000' } });
    fireEvent.submit(screen.getByPlaceholderText('e.g. 8080, 25565').closest('form')!);
    await waitFor(() =>
      expect(toastSpy.toast).toHaveBeenCalledWith('Failed to add rule', 'error'));
    confirmMock.mockRestore();
  });
});
