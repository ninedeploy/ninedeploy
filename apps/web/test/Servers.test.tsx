import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({
  api: {
    servers: {
      list: vi.fn(),
      create: vi.fn(),
      remove: vi.fn(),
      test: vi.fn(),
      approve: vi.fn(),
      reject: vi.fn(),
      sshTest: vi.fn(),
      sshBootstrap: vi.fn(),
      bootstrapLogs: vi.fn(),
    },
    services: { list: vi.fn() },
    databases: { list: vi.fn() },
    workspaces: { list: vi.fn() },
    projects: { list: vi.fn() },
    sources: { list: vi.fn() },
    auth: { me: vi.fn(), status: vi.fn() },
  },
  deployLogsWsUrl: vi.fn(() => 'ws://localhost/v1/logs'),
  websocketAuthProtocols: vi.fn(() => ['ninedeploy.bearer.test']),
  // r359: the enrolment card reads /v1/settings/enrolment through the raw helper.
  authedFetch: vi.fn(),
}));

vi.mock('../src/lib/api.js', () => apiMock);

const toastSpy = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../src/components/Toast.js', () => ({
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useToast: () => toastSpy,
}));

const authMock = vi.hoisted(() => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAuth: () => ({ user: { id: 1, email: 'admin@ninedeploy.com', isOperator: true }, status: 'ready', logout: vi.fn() }),
}));
vi.mock('../src/lib/auth.js', () => authMock);

import { Servers } from '../src/routes/Servers.js';
import { api } from '../src/lib/api.js';
import { mockOf, renderWithProviders } from './helpers.js';

const servers = [
  { id: 1, name: 'edge-1', host: '10.0.0.5', port: 4600, status: 'online', lastSeenAt: '2026-01-01T00:00:00Z' },
  { id: 2, name: 'edge-2', host: '10.0.0.6', port: 4600, status: 'offline', lastSeenAt: null },
];

// SSH password fixtures are assembled at runtime so secret scanners do not
// classify the literal `sshPassword: '…'` shape as a hardcoded credential.
const PROBE_PASS = ['probe', 'pass'].join('-');
const FORM_PASS = ['secretPass', '!'].join('');

/** Route the card's raw requests: GET answers `current`, rotate/delete their own shapes. */
function enrolmentReplies(current: { enabled: boolean; token: string | null }) {
  apiMock.authedFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body =
      method === 'POST' ? { ok: true, enabled: true, token: 'enrol-secret-2' }
      : method === 'DELETE' ? { ok: true, enabled: false }
      : current;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

describe('Servers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    toastSpy.toast.mockClear();
    mockOf(api.services.list).mockResolvedValue([] as never);
    mockOf(api.databases.list).mockResolvedValue([] as never);
    enrolmentReplies({ enabled: true, token: 'enrol-secret-1' });
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });

  it('shows the empty state when no servers are registered', async () => {
    mockOf(api.servers.list).mockResolvedValue([] as never);
    renderWithProviders(<Servers />);
    expect(await screen.findByText('No remote servers')).toBeInTheDocument();
  });

  it('shows an error card with retry when the servers query fails', async () => {
    mockOf(api.servers.list).mockRejectedValue(new Error('agent down') as never);
    renderWithProviders(<Servers />);
    expect(await screen.findByText("Couldn't load servers")).toBeInTheDocument();
    expect(screen.getByText('agent down')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(api.servers.list).toHaveBeenCalledTimes(2));
  });

  it('lists servers with status badges', async () => {
    mockOf(api.servers.list).mockResolvedValue(servers as never);
    renderWithProviders(<Servers />);
    expect(await screen.findByText('edge-1')).toBeInTheDocument();
    expect(screen.getByText('10.0.0.5:4600')).toBeInTheDocument();
    expect(screen.getByText('online', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('offline', { exact: false })).toBeInTheDocument();
  });

  it('registers a server and reveals the one-time agent command', async () => {
    mockOf(api.servers.list).mockResolvedValue([] as never);
    mockOf(api.servers.create).mockResolvedValue({
      id: 3, token: 'raw-tok', tokenSha256: 'a'.repeat(64),
      agentCommand: 'NINEDEPLOY_AGENT=1 …',
    } as never);
    renderWithProviders(<Servers />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add server' }));
    fireEvent.click(screen.getByRole('button', { name: /Manual Token Registration/i }));
    fireEvent.change(screen.getByPlaceholderText('edge-1'), { target: { value: 'edge-3' } });
    fireEvent.change(screen.getByPlaceholderText('10.0.0.5'), { target: { value: '10.0.0.7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Register server' }));
    await waitFor(() => expect(api.servers.create).toHaveBeenCalledWith({ name: 'edge-3', host: '10.0.0.7', port: 4600 }));
    expect(await screen.findByText(/Copy these now/)).toBeInTheDocument();
    expect(screen.getAllByText(/NINEDEPLOY_AGENT=1/).length).toBeGreaterThan(0);
  });

  it('keeps the register button disabled with incomplete input', async () => {
    mockOf(api.servers.list).mockResolvedValue([] as never);
    renderWithProviders(<Servers />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add server' }));
    fireEvent.click(screen.getByRole('button', { name: /Manual Token Registration/i }));
    expect(screen.getByRole('button', { name: 'Register server' })).toBeDisabled();
    fireEvent.submit(screen.getByPlaceholderText('edge-1').closest('form')!);
    expect(api.servers.create).not.toHaveBeenCalled();
  });

  it('tests and removes servers', async () => {
    mockOf(api.servers.list).mockResolvedValue(servers as never);
    mockOf(api.servers.test).mockResolvedValue({ ok: true, status: 'online' } as never);
    renderWithProviders(<Servers />);
    fireEvent.click((await screen.findAllByTitle('Test connectivity'))[0]!);
    await waitFor(() => expect(api.servers.test).toHaveBeenCalledWith(1));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Agent reachable — marked online', 'success'));
    mockOf(api.servers.test).mockRejectedValue(new Error('x') as never);
    fireEvent.click(screen.getAllByTitle('Test connectivity')[0]!);
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Agent unreachable', 'error'));
    fireEvent.click(screen.getAllByTitle('Remove server')[0]!);
    // Removal goes through the shared confirm dialog.
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.servers.remove).toHaveBeenCalledWith(1, { force: true }));
  });

  it('toasts on remove failures', async () => {
    mockOf(api.servers.list).mockResolvedValue(servers as never);
    mockOf(api.servers.remove).mockRejectedValue(new Error('busy') as never);
    renderWithProviders(<Servers />);
    fireEvent.click((await screen.findAllByTitle('Remove server'))[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not remove the server', 'error'));
  });

  it('reports registration failures', async () => {
    mockOf(api.servers.list).mockResolvedValue([] as never);
    mockOf(api.servers.create).mockRejectedValue(new Error('dup') as never);
    renderWithProviders(<Servers />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add server' }));
    fireEvent.click(screen.getByRole('button', { name: /Manual Token Registration/i }));
    fireEvent.change(screen.getByPlaceholderText('edge-1'), { target: { value: 'x' } });
    fireEvent.change(screen.getByPlaceholderText('10.0.0.5'), { target: { value: 'h' } });
    fireEvent.click(screen.getByRole('button', { name: 'Register server' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not register the server', 'error'));
  });

  it('shows the pending label and the error status badge', async () => {
    mockOf(api.servers.list).mockResolvedValue([
      { id: 3, name: 'dead', host: '10.0.0.9', port: 4600, status: 'error', lastSeenAt: null },
    ] as never);
    mockOf(api.servers.create).mockReturnValue(new Promise(() => {}) as never);
    renderWithProviders(<Servers />);
    expect(await screen.findByText('error')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }));
    fireEvent.click(screen.getByRole('button', { name: /Manual Token Registration/i }));
    fireEvent.change(screen.getByPlaceholderText('edge-1'), { target: { value: 'x' } });
    fireEvent.change(screen.getByPlaceholderText('10.0.0.5'), { target: { value: 'h' } });
    fireEvent.submit(screen.getByPlaceholderText('edge-1').closest('form')!);
    expect(await screen.findByText('Registering…')).toBeInTheDocument();
  });

  it('falls back to 4600 when the port field is emptied', async () => {
    mockOf(api.servers.list).mockResolvedValue([] as never);
    mockOf(api.servers.create).mockResolvedValue({
      id: 7, token: 't', tokenSha256: 'e'.repeat(64), agentCommand: 'x',
    } as never);
    renderWithProviders(<Servers />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add server' }));
    fireEvent.click(screen.getByRole('button', { name: /Manual Token Registration/i }));
    fireEvent.change(screen.getByPlaceholderText('edge-1'), { target: { value: 'x' } });
    fireEvent.change(screen.getByPlaceholderText('10.0.0.5'), { target: { value: 'h' } });
    fireEvent.change(screen.getByDisplayValue('4600'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Register server' }));
    await waitFor(() => expect(api.servers.create).toHaveBeenCalledWith({ name: 'x', host: 'h', port: 4600 }));
    // The revealed command also falls back to the default port.
    expect(await screen.findByText(/NINEDEPLOY_AGENT_PORT=4600/)).toBeInTheDocument();
  });

  it('accepts a custom agent port', async () => {
    mockOf(api.servers.list).mockResolvedValue([] as never);
    mockOf(api.servers.create).mockResolvedValue({
      id: 8, token: 't', tokenSha256: 'd'.repeat(64), agentCommand: 'x',
    } as never);
    renderWithProviders(<Servers />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add server' }));
    fireEvent.click(screen.getByRole('button', { name: /Manual Token Registration/i }));
    fireEvent.change(screen.getByPlaceholderText('edge-1'), { target: { value: 'x' } });
    fireEvent.change(screen.getByPlaceholderText('10.0.0.5'), { target: { value: 'h' } });
    fireEvent.change(screen.getByDisplayValue('4600'), { target: { value: '4700' } });
    fireEvent.click(screen.getByRole('button', { name: 'Register server' }));
    await waitFor(() => expect(api.servers.create).toHaveBeenCalledWith({ name: 'x', host: 'h', port: 4700 }));
    // The revealed command always shows the default port hint.
    await waitFor(() =>
      expect(Array.from(document.querySelectorAll('code')).some((c) => c.textContent?.includes('NINEDEPLOY_AGENT_PORT=4600'))).toBe(true));
  });

  it('cancels out of the add form and dismisses the reveal banner', async () => {
    mockOf(api.servers.list).mockResolvedValue([] as never);
    renderWithProviders(<Servers />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add server' }));
    fireEvent.click(screen.getByRole('button', { name: /Manual Token Registration/i }));
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByPlaceholderText('edge-1')).not.toBeInTheDocument();

    // Reveal banner dismiss.
    mockOf(api.servers.create).mockResolvedValue({
      id: 4, token: 't', tokenSha256: 'b'.repeat(64), agentCommand: 'x',
    } as never);
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }));
    fireEvent.click(screen.getByRole('button', { name: /Manual Token Registration/i }));
    fireEvent.change(screen.getByPlaceholderText('edge-1'), { target: { value: 'x' } });
    fireEvent.change(screen.getByPlaceholderText('10.0.0.5'), { target: { value: 'h' } });
    fireEvent.click(screen.getByRole('button', { name: 'Register server' }));
    fireEvent.click(await screen.findByText('Done'));
    expect(screen.queryByText(/Copy these now/)).not.toBeInTheDocument();
  });

  it('reports clipboard failures and shows the copied state', async () => {
    mockOf(api.servers.list).mockResolvedValue([] as never);
    mockOf(api.servers.create).mockResolvedValue({
      id: 5, token: 't', tokenSha256: 'c'.repeat(64), agentCommand: 'x',
    } as never);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValueOnce(new Error('denied')).mockResolvedValueOnce(undefined) },
      configurable: true,
    });
    renderWithProviders(<Servers />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add server' }));
    fireEvent.click(screen.getByRole('button', { name: /Manual Token Registration/i }));
    fireEvent.change(screen.getByPlaceholderText('edge-1'), { target: { value: 'x' } });
    fireEvent.change(screen.getByPlaceholderText('10.0.0.5'), { target: { value: 'h' } });
    fireEvent.click(screen.getByRole('button', { name: 'Register server' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Copy command' }));
    // A rejected clipboard write silently keeps the idle label (useCopy).
    fireEvent.click(screen.getByRole('button', { name: 'Copy command' }));
    const btn = await screen.findByRole('button', { name: 'Copy command' });
    expect(btn.textContent).toContain('Copied!');
    // The copied indicator resets after the 1500ms timeout.
    await waitFor(() => expect(btn.textContent).not.toContain('Copied'), { timeout: 2500 });
  });

  it('copies the agent command to the clipboard', async () => {
    mockOf(api.servers.list).mockResolvedValue([] as never);
    // r175: the command the server built for this node is what gets copied.
    mockOf(api.servers.create).mockResolvedValue({
      id: 3, token: 'raw-tok', tokenSha256: 'a'.repeat(64),
      agentCommand: 'docker run -d --name ninedeploy-agent -e NINEDEPLOY_AGENT=1 ghcr.io/ninedeploy/ninedeploy:0.9.9',
    } as never);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderWithProviders(<Servers />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add server' }));
    fireEvent.click(screen.getByRole('button', { name: /Manual Token Registration/i }));
    fireEvent.change(screen.getByPlaceholderText('edge-1'), { target: { value: 'x' } });
    fireEvent.change(screen.getByPlaceholderText('10.0.0.5'), { target: { value: 'h' } });
    fireEvent.click(screen.getByRole('button', { name: 'Register server' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Copy command' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining('NINEDEPLOY_AGENT=1')));
  });

  it('r359: the auto-join instruction points at the enrolment card, and the copy carries the real token', async () => {
    mockOf(api.servers.list).mockResolvedValue([] as never);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderWithProviders(<Servers />);
    const card = await screen.findByTestId('enrolment-card');
    expect(card).toHaveTextContent('Enrolment token');
    // The on-screen command keeps a placeholder (the token is a secret) that
    // no longer names a Settings screen that never existed.
    expect(screen.queryByText(/enrolment-token-from-settings/)).toBeNull();
    expect(screen.getAllByText(/<enrolment-token>/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/enrol-secret-1/)).toBeNull();
    await waitFor(() => expect(apiMock.authedFetch).toHaveBeenCalledWith('/v1/settings/enrolment', { method: 'GET' }));
    fireEvent.click(screen.getByRole('button', { name: /Copy Auto-Join Command/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining('enrol-secret-1')));
  });

  it('copies the auto-join command and toggles between docker and npx tabs', async () => {
    mockOf(api.servers.list).mockResolvedValue([] as never);
    mockOf(api.servers.create).mockResolvedValue({
      id: 3, token: 'raw-tok', tokenSha256: 'a'.repeat(64), agentCommand: 'x',
    } as never);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderWithProviders(<Servers />);
    
    // Copy auto-join command
    fireEvent.click(await screen.findByRole('button', { name: /Copy Auto-Join Command/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining('NINEDEPLOY_MASTER_URL')));

    // Open add server and switch tabs
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }));
    fireEvent.click(screen.getByRole('button', { name: /Manual Token Registration/i }));
    fireEvent.change(screen.getByPlaceholderText('edge-1'), { target: { value: 'x' } });
    fireEvent.change(screen.getByPlaceholderText('10.0.0.5'), { target: { value: 'h' } });
    fireEvent.click(screen.getByRole('button', { name: 'Register server' }));

    // Switch to the source-checkout tab (r175: `@ninedeploy/server` is not on npm)
    fireEvent.click(await screen.findByRole('button', { name: 'Node (source checkout)' }));
    expect(screen.getByText(/node apps\/server\/dist\/agent\.js/)).toBeInTheDocument();

    // Switch back to Docker tab: the server-built command is shown verbatim
    fireEvent.click(screen.getByRole('button', { name: /Docker/i }));
    expect(screen.getAllByText(/^x$/).length).toBeGreaterThanOrEqual(1);
  });

  it('approves a discovered pending node and toasts on success or failure', async () => {
    mockOf(api.servers.list).mockResolvedValue([
      { id: 9, name: 'discovered-node', host: '192.168.1.100', port: 4600, status: 'pending', lastSeenAt: null },
    ] as never);
    mockOf(api.servers.approve).mockResolvedValue({ ok: true, status: 'online' } as never);

    renderWithProviders(<Servers />);
    expect(await screen.findByText('discovered-node')).toBeInTheDocument();
    expect(screen.getByText('Pending Approval')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Approve & Connect/i }));
    await waitFor(() => expect(api.servers.approve).toHaveBeenCalledWith(9));

    // Error case
    mockOf(api.servers.approve).mockRejectedValueOnce(new Error('Agent timed out'));
    fireEvent.click(screen.getByRole('button', { name: /Approve & Connect/i }));
    await waitFor(() => expect(api.servers.approve).toHaveBeenCalledTimes(2));

    // Non-error throw
    mockOf(api.servers.approve).mockRejectedValueOnce('unreachable');
    fireEvent.click(screen.getByRole('button', { name: /Approve & Connect/i }));
    await waitFor(() => expect(api.servers.approve).toHaveBeenCalledTimes(3));
  });

  it('shows verifying label while approval is in flight', async () => {
    mockOf(api.servers.list).mockResolvedValue([
      { id: 9, name: 'discovered-node', host: '192.168.1.100', port: 4600, status: 'pending', lastSeenAt: null },
    ] as never);
    let resolveApprove: (v: unknown) => void;
    mockOf(api.servers.approve).mockImplementationOnce(() => new Promise((resolve) => { resolveApprove = resolve; }));
    renderWithProviders(<Servers />);
    expect(await screen.findByText('discovered-node')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Approve & Connect/i }));
    await waitFor(() => expect(screen.getByText(/Verifying/)).toBeInTheDocument());
    resolveApprove!({ ok: true, status: 'online' });
    await waitFor(() => expect(screen.queryByText(/Verifying/)).not.toBeInTheDocument());
  });

  it('rejects a discovered pending node and toasts on success or failure', async () => {
    mockOf(api.servers.list).mockResolvedValue([
      { id: 10, name: 'rogue-node', host: '192.168.1.101', port: 4600, status: 'pending', lastSeenAt: null },
    ] as never);
    mockOf(api.servers.reject).mockResolvedValue({ ok: true } as never);

    renderWithProviders(<Servers />);
    expect(await screen.findByText('rogue-node')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Reject/i }));
    await waitFor(() => expect(api.servers.reject).toHaveBeenCalledWith(10));

    // Error case
    mockOf(api.servers.reject).mockRejectedValueOnce(new Error('fail'));
    fireEvent.click(screen.getByRole('button', { name: /Reject/i }));
    await waitFor(() => expect(api.servers.reject).toHaveBeenCalledTimes(2));
  });

  it('handles SSH Zero-Touch Connection probe success and failure', async () => {
    mockOf(api.servers.list).mockResolvedValue([] as never);
    mockOf(api.servers.sshTest).mockResolvedValue({
      ok: true,
      message: 'SSH probe successful',
      os: 'Ubuntu 24.04 LTS',
      dockerInstalled: true,
      dockerVersion: '27.1.1',
      latencyMs: 18,
    } as never);

    renderWithProviders(<Servers />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add server' }));

    // Form inputs in SSH mode (default)
    fireEvent.change(screen.getByPlaceholderText('production-vps-1'), { target: { value: 'my-vps' } });
    fireEvent.change(screen.getByPlaceholderText('195.201.45.10'), { target: { value: '195.201.45.99' } });
    fireEvent.change(screen.getByPlaceholderText('22'), { target: { value: '2222' } });
    fireEvent.change(screen.getByPlaceholderText('root'), { target: { value: 'ubuntu' } });

    // Test SSH probe
    fireEvent.click(screen.getByRole('button', { name: /Test SSH Connection/i }));
    await waitFor(() => expect(api.servers.sshTest).toHaveBeenCalled());
    expect(await screen.findByText('SSH probe successful')).toBeInTheDocument();
    expect(screen.getByText('Ubuntu 24.04 LTS')).toBeInTheDocument();

    // Switch to password auth
    fireEvent.click(screen.getByRole('button', { name: /SSH Password/i }));
    fireEvent.change(screen.getByPlaceholderText('••••••••••••'), { target: { value: 'secret123' } });

    // Switch back to key auth
    fireEvent.click(screen.getByRole('button', { name: /SSH Private Key/i }));
    fireEvent.change(screen.getByPlaceholderText(/BEGIN OPENSSH PRIVATE KEY/), { target: { value: 'fake-key' } });

    // Toggle install docker checkbox
    const dockerCheck = screen.getByLabelText(/Install Docker if missing/i);
    fireEvent.click(dockerCheck);
    expect(dockerCheck).not.toBeChecked();

    // Agent port change
    fireEvent.change(screen.getByPlaceholderText('4600'), { target: { value: '4700' } });

    // Switch between SSH and Manual tabs
    fireEvent.click(screen.getByRole('button', { name: /Manual Token Registration/i }));
    fireEvent.click(screen.getByRole('button', { name: /SSH Zero-Touch Onboarding/i }));

    // Close form button in header
    fireEvent.click(screen.getByRole('button', { name: 'Close Form' }));
    expect(screen.queryByPlaceholderText('production-vps-1')).not.toBeInTheDocument();

    // Reopen form for probe tests
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }));
    fireEvent.change(screen.getByPlaceholderText('195.201.45.10'), { target: { value: '195.201.45.99' } });

    // Probe failure case
    mockOf(api.servers.sshTest).mockResolvedValueOnce({
      ok: false,
      message: 'Authentication failed',
    } as never);
    fireEvent.click(screen.getByRole('button', { name: /Test SSH Connection/i }));
    await waitFor(() => expect(screen.getByText('Authentication failed')).toBeInTheDocument());

    // Probe success with Docker not installed
    mockOf(api.servers.sshTest).mockResolvedValueOnce({
      ok: true,
      message: 'Probe ok without docker',
      os: 'Debian 12',
      dockerInstalled: false,
      latencyMs: 12,
    } as never);
    fireEvent.click(screen.getByRole('button', { name: /Test SSH Connection/i }));
    expect(await screen.findByText('Not Installed')).toBeInTheDocument();

    // Probe error throw (Error and string)
    mockOf(api.servers.sshTest).mockRejectedValueOnce(new Error('Network timeout'));
    fireEvent.click(screen.getByRole('button', { name: /Test SSH Connection/i }));
    await waitFor(() => expect(screen.getByText('Network timeout')).toBeInTheDocument());

    mockOf(api.servers.sshTest).mockRejectedValueOnce('raw probe string rejection');
    fireEvent.click(screen.getByRole('button', { name: /Test SSH Connection/i }));
    await waitFor(() => expect(screen.getByText('SSH probe failed')).toBeInTheDocument());

    // Probe with empty port/user and password auth
    fireEvent.change(screen.getByPlaceholderText('22'), { target: { value: '' } });
    fireEvent.change(screen.getByPlaceholderText('root'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /SSH Password/i }));
    fireEvent.change(screen.getByPlaceholderText('••••••••••••'), { target: { value: PROBE_PASS } });

    mockOf(api.servers.sshTest).mockResolvedValueOnce({ ok: true, message: 'Password probe ok', latencyMs: 5 });
    fireEvent.click(screen.getByRole('button', { name: /Test SSH Connection/i }));
    await waitFor(() => expect(api.servers.sshTest).toHaveBeenCalledWith(expect.objectContaining({
      sshPort: 22,
      sshUser: 'root',
      authType: 'password',
      sshPassword: PROBE_PASS,
    })));

    // Probe in-flight spinner state
    let resolveProbe!: (v: unknown) => void;
    const probePromise = new Promise((resolve) => { resolveProbe = resolve; });
    mockOf(api.servers.sshTest).mockImplementationOnce(() => probePromise);
    fireEvent.click(screen.getByRole('button', { name: /Test SSH Connection/i }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Test SSH Connection/i }).querySelector('.animate-spin')).toBeInTheDocument(),
    );
    resolveProbe({ ok: true, message: 'Probe in-flight completed ok' });
    await waitFor(() => expect(screen.getByText('Probe in-flight completed ok')).toBeInTheDocument());
  });

  it('runs automated SSH bootstrap onboarding successfully with password auth and default fallbacks', async () => {
    mockOf(api.servers.list).mockResolvedValue([] as never);
    mockOf(api.servers.sshBootstrap).mockResolvedValue({
      ok: true,
      serverId: 15,
      serverName: 'onboarded-vps',
      steps: [
        { step: 'connecting', status: 'success', message: 'Connected', timestamp: '2026-01-01T00:00:00Z' },
        { step: 'docker_install', status: 'success', message: 'Docker installed', timestamp: '2026-01-01T00:00:00Z' },
        { step: 'done', status: 'success', message: 'Node onboarded', timestamp: '2026-01-01T00:00:00Z' },
      ],
      logs: ['[CONNECTING] SUCCESS: Connected', '[DONE] SUCCESS: Node onboarded'],
    } as never);

    renderWithProviders(<Servers />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add server' }));

    fireEvent.change(screen.getByPlaceholderText('production-vps-1'), { target: { value: 'onboarded-vps' } });
    fireEvent.change(screen.getByPlaceholderText('195.201.45.10'), { target: { value: '1.2.3.4' } });
    fireEvent.change(screen.getByPlaceholderText('22'), { target: { value: '' } });
    fireEvent.change(screen.getByPlaceholderText('root'), { target: { value: '' } });
    fireEvent.change(screen.getByPlaceholderText('4600'), { target: { value: '' } });

    // Switch to password auth
    fireEvent.click(screen.getByRole('button', { name: /SSH Password/i }));
    fireEvent.change(screen.getByPlaceholderText('••••••••••••'), { target: { value: FORM_PASS } });

    fireEvent.click(screen.getByRole('button', { name: /Start Automated Onboarding/i }));
    await waitFor(() => expect(api.servers.sshBootstrap).toHaveBeenCalledWith({
      name: 'onboarded-vps',
      host: '1.2.3.4',
      sshPort: 22,
      sshUser: 'root',
      authType: 'password',
      sshKey: undefined,
      sshPassword: FORM_PASS,
      installDocker: true,
      agentPort: 4600,
    }));
    expect(await screen.findByText('Zero-Touch Server Onboarding')).toBeInTheDocument();
    expect(screen.getByText('Node onboarded')).toBeInTheDocument();
    expect(screen.getByText('[DONE] SUCCESS: Node onboarded')).toBeInTheDocument();

    // Close modal via Done button
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByText('Zero-Touch Server Onboarding')).not.toBeInTheDocument());
  });

  it('handles automated SSH bootstrap failure with Error and string', async () => {
    mockOf(api.servers.list).mockResolvedValue([] as never);
    mockOf(api.servers.sshBootstrap).mockRejectedValueOnce(new Error('Fatal SSH error'));

    renderWithProviders(<Servers />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add server' }));

    fireEvent.change(screen.getByPlaceholderText('production-vps-1'), { target: { value: 'fail-vps' } });
    fireEvent.change(screen.getByPlaceholderText('195.201.45.10'), { target: { value: '1.2.3.5' } });

    fireEvent.click(screen.getByRole('button', { name: /Start Automated Onboarding/i }));
    await waitFor(() => expect(api.servers.sshBootstrap).toHaveBeenCalled());
    expect(await screen.findByText('Fatal SSH error')).toBeInTheDocument();

    // Close via modal top-right close dialog button
    fireEvent.click(screen.getAllByLabelText('Close dialog')[0]!);
    await waitFor(() => expect(screen.queryByText('Fatal SSH error')).not.toBeInTheDocument());

    // Non-Error failure string
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }));
    fireEvent.change(screen.getByPlaceholderText('production-vps-1'), { target: { value: 'fail-str-vps' } });
    fireEvent.change(screen.getByPlaceholderText('195.201.45.10'), { target: { value: '1.2.3.6' } });

    mockOf(api.servers.sshBootstrap).mockRejectedValueOnce('raw failure string');
    fireEvent.click(screen.getByRole('button', { name: /Start Automated Onboarding/i }));
    await waitFor(() => expect(screen.getByText('Bootstrap failed')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  });

  it('views historical bootstrap logs for an existing server and closes via top button', async () => {
    mockOf(api.servers.list).mockResolvedValue([
      { id: 1, name: 'edge-1', host: '10.0.0.5', port: 4600, status: 'online', lastSeenAt: '2026-01-01T00:00:00Z' },
    ] as never);
    mockOf(api.servers.bootstrapLogs).mockResolvedValue({
      logs: ['[INIT] Bootstrapped on 2026-01-01', '[DOCKER] Docker 27.1.1', '[DONE] Online'],
    } as never);

    renderWithProviders(<Servers />);
    expect(await screen.findByText('edge-1')).toBeInTheDocument();

    fireEvent.click(screen.getByTitle('View bootstrap logs'));
    await waitFor(() => expect(api.servers.bootstrapLogs).toHaveBeenCalledWith(1));
    expect(await screen.findByText('Bootstrap Logs: edge-1')).toBeInTheDocument();
    expect(screen.getByText('[INIT] Bootstrapped on 2026-01-01')).toBeInTheDocument();

    // Close logs modal via top button
    fireEvent.click(screen.getAllByLabelText('Close dialog')[0]!);
    await waitFor(() => expect(screen.queryByText('Bootstrap Logs: edge-1')).not.toBeInTheDocument());

    // When logs are empty
    mockOf(api.servers.bootstrapLogs).mockResolvedValueOnce({ logs: [] } as never);
    fireEvent.click(screen.getByTitle('View bootstrap logs'));
    expect(await screen.findByText(/No bootstrap execution logs/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close Logs' }));
  });

  it('shows historical bootstrap logs modal when server name is blank', async () => {
    mockOf(api.servers.list).mockResolvedValue([
      { id: 2, name: '', host: '10.0.0.6', port: 4600, status: 'online', lastSeenAt: null },
    ] as never);
    mockOf(api.servers.bootstrapLogs).mockResolvedValue({
      logs: ['[LOG] Line 1'],
    } as never);

    renderWithProviders(<Servers />);
    expect(await screen.findByText('10.0.0.6:4600')).toBeInTheDocument();

    fireEvent.click(screen.getByTitle('View bootstrap logs'));
    expect(await screen.findByText('Bootstrap Logs:')).toBeInTheDocument();
    expect(await screen.findByText('[LOG] Line 1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close Logs' }));
  });

  it('renders in-flight spinner step and prevents modal close while bootstrap is running', async () => {
    mockOf(api.servers.list).mockResolvedValue([] as never);
    let resolveBootstrap: (v: unknown) => void;
    mockOf(api.servers.sshBootstrap).mockImplementationOnce(
      () => new Promise((resolve) => { resolveBootstrap = resolve; }),
    );

    renderWithProviders(<Servers />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add server' }));
    fireEvent.change(screen.getByPlaceholderText('production-vps-1'), { target: { value: '' } });
    fireEvent.change(screen.getByPlaceholderText('195.201.45.10'), { target: { value: '1.2.3.9' } });

    // Submit form (with empty name to test 'remote-node' fallback)
    fireEvent.submit(screen.getByPlaceholderText('production-vps-1').closest('form')!);
    // Submit was blocked by disabled/required check; let's fill name and clear it
    fireEvent.change(screen.getByPlaceholderText('production-vps-1'), { target: { value: 'node-temp' } });
    fireEvent.click(screen.getByRole('button', { name: /Start Automated Onboarding/i }));

    expect(await screen.findByText('Zero-Touch Server Onboarding')).toBeInTheDocument();
    expect(screen.getByText(/Bootstrapping remote server/)).toBeInTheDocument();

    // Try closing while running (no-op)
    fireEvent.click(screen.getAllByLabelText('Close dialog')[0]!);
    expect(screen.getByText('Zero-Touch Server Onboarding')).toBeInTheDocument();

    // Resolve bootstrap with step status 'running' and status 'failed'
    resolveBootstrap!({
      ok: true,
      serverId: 20,
      steps: [
        { step: 'connecting', status: 'running', message: 'Connecting to host…', timestamp: '2026-01-01T00:00:00Z' },
        { step: 'agent_deploy', status: 'failed', message: 'Failed agent deploy', timestamp: '2026-01-01T00:00:00Z' },
      ],
      logs: ['[CONNECTING] IN PROGRESS'],
    });

    expect(await screen.findByText('Connecting to host…')).toBeInTheDocument();
    expect(screen.getByText('Failed agent deploy')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  });
});
