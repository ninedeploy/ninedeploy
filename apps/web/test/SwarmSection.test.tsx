import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithProviders } from './web-utils.js';

/**
 * Multi-node, Settings → Swarm (operator only): initialise with the advertise
 * address and the password re-check, enable (step-up) / disable, the nodes,
 * the firewall hint and the server's warnings. Also the section's wiring in
 * the Settings page (operators only).
 */

const apiMock = vi.hoisted(() => ({
  api: {
    swarm: { get: vi.fn(), init: vi.fn(), settings: vi.fn() },
  },
}));
vi.mock('../src/lib/api.js', () => apiMock);

const toastSpy = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../src/components/Toast.js', () => ({
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useToast: () => toastSpy,
}));

const authState = vi.hoisted(() => ({ user: { id: 1, isOperator: true } as { id: number; isOperator: boolean } }));
vi.mock('../src/lib/auth.js', () => ({
  AuthProvider: ({ children }: { children?: React.ReactNode }) => children,
  useAuth: () => ({ user: authState.user, loading: false }),
}));

import { SwarmSection } from '../src/routes/settings/SwarmSection.js';
import { Settings } from '../src/routes/settings/index.js';

const swarm = apiMock.api.swarm;
const PASS = ['step', 'up', 'pw'].join('-');

const status = (over: Record<string, unknown> = {}) => ({
  enabled: false,
  localState: 'inactive',
  controlAvailable: false,
  managerAddr: null,
  nodes: [],
  ...over,
});

const ACTIVE = {
  localState: 'active',
  controlAvailable: true,
  managerAddr: '10.0.0.2:2377',
};

const coded = (message: string, code: string) => Object.assign(new Error(message), { code });

describe('SwarmSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.user = { id: 1, isOperator: true };
  });

  it('initialises Swarm with the advertise address and the password, and shows the warnings', async () => {
    swarm.get.mockResolvedValue(status());
    swarm.init.mockResolvedValue(status({ ...ACTIVE, warnings: ['Firewall 2377/tcp to the cluster'] }));
    renderWithProviders(<SwarmSection />);
    expect(await screen.findByText('inactive')).toBeInTheDocument();
    // The firewall hint and the node opt-in line are always shown.
    expect(screen.getByText('4789/udp (overlay VXLAN traffic)')).toBeInTheDocument();
    expect(screen.getByText(/ESP, IP protocol 50/)).toBeInTheDocument();
    expect(screen.getByText(/not support on Windows hosts/)).toBeInTheDocument();
    expect(screen.getByText('NINEDEPLOY_AGENT_SWARM_MANAGER=<advertise addr>:2377')).toBeInTheDocument();
    // Enabling is impossible before initialising.
    expect(screen.getByRole('switch', { name: 'Swarm deploys' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Initialise Swarm' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Advertise address'), { target: { value: 'not-an-ip' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Initialise Swarm' }));
    expect(await within(dialog).findByText(/Enter the IPv4 or IPv6 address/)).toBeInTheDocument();
    expect(swarm.init).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText('Advertise address'), { target: { value: '10.0.0.2' } });
    fireEvent.change(within(dialog).getByLabelText('Your password'), { target: { value: PASS } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Initialise Swarm' }));
    await waitFor(() => expect(swarm.init).toHaveBeenCalledWith({ advertiseAddr: '10.0.0.2', password: PASS }));
    expect(await screen.findByText('Firewall 2377/tcp to the cluster')).toBeInTheDocument();
    expect(screen.getByText('manager')).toBeInTheDocument();
    expect(screen.getByText('NINEDEPLOY_AGENT_SWARM_MANAGER=10.0.0.2:2377')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a wrong password keeps the prompt open with the reason; SSO accounts send no password', async () => {
    swarm.get.mockResolvedValue(status());
    swarm.init.mockRejectedValueOnce(coded('Invalid password', 'invalid_password'));
    swarm.init.mockResolvedValueOnce(status(ACTIVE));
    renderWithProviders(<SwarmSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Initialise Swarm' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Advertise address'), { target: { value: 'fd00::2' } });
    fireEvent.change(within(dialog).getByLabelText('Your password'), { target: { value: 'wrong' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Initialise Swarm' }));
    expect(await within(dialog).findByText('Invalid password')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Your password'), { target: { value: '' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Initialise Swarm' }));
    await waitFor(() => expect(swarm.init).toHaveBeenLastCalledWith({ advertiseAddr: 'fd00::2' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Swarm initialised on the panel host', 'success'));
  });

  it('an initialised swarm without encrypted overlays: the prompt closes and the reason stays on the page', async () => {
    swarm.get.mockResolvedValue(status());
    swarm.init.mockRejectedValue(coded('Swarm was initialised on the panel host, but it cannot run NineDeploy services yet.', 'swarm_overlay_unavailable'));
    renderWithProviders(<SwarmSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Initialise Swarm' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Advertise address'), { target: { value: '10.0.0.2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Initialise Swarm' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('cannot run NineDeploy services yet');
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(swarm.get).toHaveBeenCalledTimes(2));
  });

  it('other init failures stay in the prompt; Cancel closes it', async () => {
    swarm.get.mockResolvedValue(status());
    swarm.init.mockRejectedValue('nope');
    renderWithProviders(<SwarmSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Initialise Swarm' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Advertise address'), { target: { value: '10.0.0.2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Initialise Swarm' }));
    expect(await within(dialog).findByText('Could not initialise Swarm')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('enables Swarm deploys after the password re-check, and disables them without one', async () => {
    swarm.get.mockResolvedValue(
      status({
        ...ACTIVE,
        nodes: [
          { id: 'abcdef0123456789', hostname: '', role: 'manager', availability: 'active', state: 'ready', serverId: null },
          { id: 'n2', hostname: 'edge-1', role: 'worker', availability: 'drain', state: 'down', serverId: 3, warnings: ['Socket off on edge-1'] },
        ],
        warnings: ['2377/tcp listens on every interface'],
      }),
    );
    swarm.settings.mockRejectedValueOnce(coded('Invalid password', 'invalid_password'));
    swarm.settings.mockResolvedValueOnce(status({ ...ACTIVE, enabled: true }));
    renderWithProviders(<SwarmSection />);
    expect(await screen.findByText('abcdef012345')).toBeInTheDocument();
    expect(screen.getByText('(panel host or foreign)')).toBeInTheDocument();
    expect(screen.getByText('Socket off on edge-1')).toBeInTheDocument();
    expect(screen.getByText('2377/tcp listens on every interface')).toBeInTheDocument();
    expect(screen.getByText('Enabling asks for your password again.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('switch', { name: 'Swarm deploys' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Your password'), { target: { value: 'wrong' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enable Swarm deploys' }));
    expect(await within(dialog).findByText('Invalid password')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Your password'), { target: { value: PASS } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enable Swarm deploys' }));
    await waitFor(() => expect(swarm.settings).toHaveBeenLastCalledWith({ enabled: true, password: PASS }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Swarm deploys' })).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByText(/next deploy refuse/)).toBeInTheDocument();

    swarm.settings.mockResolvedValueOnce(status({ ...ACTIVE, enabled: false }));
    fireEvent.click(screen.getByRole('switch', { name: 'Swarm deploys' }));
    await waitFor(() => expect(swarm.settings).toHaveBeenLastCalledWith({ enabled: false }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Swarm deploys disabled', 'success'));
    // Off again: switching on reopens the prompt, which Cancel closes.
    fireEvent.click(screen.getByRole('switch', { name: 'Swarm deploys' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('disabling can fail (toasted); an active daemon that is not a manager cannot be enabled', async () => {
    swarm.get.mockResolvedValue(status({ ...ACTIVE, enabled: true }));
    swarm.settings.mockRejectedValue(new Error('db locked'));
    renderWithProviders(<SwarmSection />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Swarm deploys' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('db locked', 'error'));

    swarm.get.mockResolvedValue(status({ localState: 'active', controlAvailable: false, managerAddr: null }));
    const second = renderWithProviders(<SwarmSection />);
    expect(await second.findByText('not a manager')).toBeInTheDocument();
    expect(second.getAllByRole('switch', { name: 'Swarm deploys' }).at(-1)).toBeDisabled();
  });

  it('a locked or failed daemon and a load failure', async () => {
    swarm.get.mockResolvedValueOnce(status({ localState: 'locked' }));
    renderWithProviders(<SwarmSection />);
    expect(await screen.findByText('locked')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Initialise Swarm' })).toBeNull();
    swarm.get.mockRejectedValueOnce(new Error('not found'));
    const second = renderWithProviders(<SwarmSection />);
    expect(await second.findByText("Couldn't load the Swarm status")).toBeInTheDocument();
  });
});

describe('Settings → Swarm wiring', () => {
  it('operators get a Swarm section that renders the card; members do not', async () => {
    swarm.get.mockResolvedValue(status());
    renderWithProviders(<Settings />, { route: '/settings?section=swarm' });
    expect(await screen.findByText('Docker Swarm')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^Swarm/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('a member deep-linking ?section=swarm lands on the account section', () => {
    authState.user = { id: 2, isOperator: false };
    swarm.get.mockClear();
    renderWithProviders(<Settings />, { route: '/settings?section=swarm' });
    expect(screen.queryByRole('tab', { name: /^Swarm/ })).toBeNull();
    expect(swarm.get).not.toHaveBeenCalled();
  });
});
