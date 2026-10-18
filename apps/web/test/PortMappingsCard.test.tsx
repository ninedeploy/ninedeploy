import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { PortMappingsCard, portMappingLabel, rowToMapping } from '../src/routes/service/PortMappingsCard.js';
import { api } from '../src/lib/api.js';
import { mockOf, renderWithProviders } from './helpers.js';

/** 0.16.1 Network → Port mappings: rows → `-p` operands, checks before saving, cleared with nothing left, hidden where unavailable. */

vi.mock('../src/lib/api.js', async () => {
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});
vi.mock('../src/lib/auth.js', async () => {
  const { createAuthMock } = await import('./apiMock.js');
  return createAuthMock();
});
const toastSpy = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../src/components/Toast.js', async () => {
  const actual = await vi.importActual<typeof import('../src/components/Toast.js')>('../src/components/Toast.js');
  return { ...actual, useToast: () => toastSpy };
});

const svc = (over: Record<string, unknown> = {}) => ({ id: 3, type: 'docker', serverId: null, portMappings: [], ...over }) as never;
const udp = { hostIp: null, hostPort: 27015, hostPortEnd: 27030, containerPort: 27015, protocol: 'udp' as const };

beforeEach(() => {
  vi.clearAllMocks();
  mockOf(api.services.update).mockResolvedValue({} as never);
});

describe('rowToMapping', () => {
  it('builds the mapping from the fields, an empty container port meaning the same ports', () => {
    expect(rowToMapping({ ip: '', host: '27015-27030', container: '', protocol: 'udp' })).toEqual(udp);
    expect(rowToMapping({ ip: ' 2001:db8::7 ', host: '53', container: '5353', protocol: 'tcp' })).toMatchObject({ hostIp: '2001:db8::7', containerPort: 5353 });
    expect(rowToMapping({ ip: '', host: ' ', container: '', protocol: 'tcp' })).toMatch(/host port/);
    expect(rowToMapping({ ip: '0.0.0.0', host: '80', container: '', protocol: 'tcp' })).toMatch(/not an address/);
    expect(rowToMapping({ ip: '', host: '5432', container: '', protocol: 'tcp', allow: '10.0.0.0/8, 203.0.113.4' })).toMatchObject({ allowFrom: ['10.0.0.0/8', '203.0.113.4'] });
    // A UDP row or a range never carries one, even with text left in the field.
    expect(rowToMapping({ ip: '', host: '53', container: '', protocol: 'udp', allow: '10.0.0.0/8' })).not.toHaveProperty('allowFrom');
    expect(rowToMapping({ ip: '', host: '6000-6001', container: '', protocol: 'tcp', allow: '10.0.0.0/8' })).not.toHaveProperty('allowFrom');
  });
});

describe('portMappingLabel', () => {
  it('names the first mapping and counts the rest', () => {
    expect(portMappingLabel([])).toBe('');
    expect(portMappingLabel([udp])).toBe(':27015-27030/udp');
    expect(portMappingLabel([{ ...udp, hostIp: '203.0.113.7', hostPortEnd: null }, udp, udp])).toBe('203.0.113.7:27015/udp +2');
    expect(portMappingLabel([{ ...udp, hostIp: '2001:db8::7', protocol: 'tcp' }])).toBe('[2001:db8::7]:27015-27030/tcp');
  });
});

describe('PortMappingsCard', () => {
  it('adds a UDP range on a dedicated IP and saves it', async () => {
    renderWithProviders(<PortMappingsCard serviceId={3} svc={svc()} />);
    expect(screen.getByText('No extra ports published.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Mapping/ }));
    fireEvent.change(screen.getByLabelText('Mapping 1 host IP'), { target: { value: '203.0.113.7' } });
    fireEvent.change(screen.getByLabelText('Mapping 1 host ports'), { target: { value: '27015-27030' } });
    expect(screen.getByText('-p 203.0.113.7:27015-27030:27015-27030/udp')).toBeInTheDocument();
    expect(screen.getByText('16 host ports')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save mappings' }));
    await waitFor(() => expect(api.services.update).toHaveBeenCalledWith(3, { portMappings: [{ ...udp, hostIp: '203.0.113.7' }] }));
    expect(toastSpy.toast).toHaveBeenCalledWith('Port mappings saved — redeploy to publish them', 'success');
  });

  it('shows the stored rules, switches protocol, flags overlaps, and clears with null', async () => {
    renderWithProviders(<PortMappingsCard serviceId={3} svc={svc({ portMappings: [udp, { ...udp, hostPort: 9000, hostPortEnd: null, containerPort: 9000, protocol: 'tcp' }] })} />);
    expect(screen.getByLabelText('Mapping 1 host ports')).toHaveValue('27015-27030');
    expect(screen.getByText('17 host ports')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Mapping 2 host ports'), { target: { value: '27020' } });
    fireEvent.change(screen.getByLabelText('Mapping 2 protocol'), { target: { value: 'udp' } });
    expect(screen.getByText(/overlaps/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save mappings' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Mapping 2 host ports'), { target: { value: 'x' } });
    expect(screen.getByText(/not a port mapping/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove mapping 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove mapping 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save mappings' }));
    await waitFor(() => expect(api.services.update).toHaveBeenCalledWith(3, { portMappings: null }));
    expect(toastSpy.toast).toHaveBeenCalledWith('Port mappings removed — redeploy to unpublish them', 'success');
  });

  it("reports the server's reason when saving fails", async () => {
    mockOf(api.services.update).mockRejectedValue(new Error('Host port 27020/udp is already published by service "voice".'));
    renderWithProviders(<PortMappingsCard serviceId={3} svc={svc({ portMappings: [udp] })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save mappings' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Host port 27020/udp is already published by service "voice".', 'error'));
    mockOf(api.services.update).mockRejectedValue(new Error(''));
    fireEvent.click(screen.getByRole('button', { name: 'Save mappings' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not save the port mappings', 'error'));
  });

  it('a single TCP port takes an allow list and goes through the proxy; UDP rows offer none', async () => {
    renderWithProviders(<PortMappingsCard serviceId={3} svc={svc({ portMappings: [udp, { hostIp: null, hostPort: 5432, hostPortEnd: null, containerPort: 5432, protocol: 'tcp', allowFrom: ['10.0.0.0/8'] }] })} />);
    expect(screen.queryByLabelText('Mapping 1 allow from')).not.toBeInTheDocument();
    const allow = screen.getByLabelText('Mapping 2 allow from');
    expect(allow).toHaveValue('10.0.0.0/8');
    expect(screen.getByText('5432:5432/tcp via the allow-list proxy')).toBeInTheDocument();
    fireEvent.change(allow, { target: { value: '10.0.0.0/8, 198.51.100.0/24' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save mappings' }));
    await waitFor(() =>
      expect(api.services.update).toHaveBeenCalledWith(3, {
        portMappings: [udp, { hostIp: null, hostPort: 5432, hostPortEnd: null, containerPort: 5432, protocol: 'tcp', allowFrom: ['10.0.0.0/8', '198.51.100.0/24'] }],
      }),
    );
  });

  it("offers the panel host's IPs in the Host IP field", async () => {
    mockOf(api.services.hostAddresses).mockResolvedValue({
      detected: true,
      addresses: [
        { ip: '203.0.113.7', family: 4, iface: 'eth0', label: 'main', primary: true, dedicated: null },
        { ip: '2001:db8::7', family: 6, iface: 'eth0', dedicated: 'self' },
        { ip: '203.0.113.9', family: 4, iface: 'eth0', dedicated: 'other' },
      ],
    });
    renderWithProviders(<PortMappingsCard serviceId={3} svc={svc({ portMappings: [udp] })} />);
    expect(await screen.findByText('2001:db8::7, 203.0.113.7')).toBeInTheDocument();
    expect(api.services.hostAddresses).toHaveBeenCalledWith(3);
    const field = screen.getByLabelText('Mapping 1 host IP');
    expect(field).toHaveAttribute('list', 'host-ips-3');
    const options = [...document.querySelectorAll('#host-ips-3 option')];
    // Another service's dedicated address is not offered; this service's own comes first.
    expect(options.map((o) => o.getAttribute('value'))).toEqual(['2001:db8::7', '203.0.113.7']);
    expect(options[0]).toHaveTextContent('dedicated to this service, eth0, IPv6');
    expect(options[1]).toHaveTextContent('main, primary, eth0, IPv4');
  });

  it('suggests the "container running" healthcheck when only UDP is published', async () => {
    renderWithProviders(<PortMappingsCard serviceId={3} svc={svc({ portMappings: [udp], healthCheck: 'http' })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Use "container running"' }));
    await waitFor(() => expect(api.services.update).toHaveBeenCalledWith(3, { healthCheck: 'running' }));
    expect(toastSpy.toast).toHaveBeenCalledWith('Healthcheck set to "container running"', 'success');

    mockOf(api.services.update).mockRejectedValue(new Error(''));
    fireEvent.click(screen.getByRole('button', { name: 'Use "container running"' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not change the healthcheck', 'error'));
  });

  it('no healthcheck hint once TCP is published or the mode is already "running"', () => {
    const { unmount } = renderWithProviders(<PortMappingsCard serviceId={3} svc={svc({ portMappings: [udp, { ...udp, hostPort: 9000, hostPortEnd: null, containerPort: 9000, protocol: 'tcp' }], healthCheck: 'http' })} />);
    expect(screen.queryByRole('button', { name: 'Use "container running"' })).not.toBeInTheDocument();
    unmount();
    renderWithProviders(<PortMappingsCard serviceId={3} svc={svc({ portMappings: [udp], healthCheck: 'running' })} />);
    expect(screen.queryByRole('button', { name: 'Use "container running"' })).not.toBeInTheDocument();
  });

  it("on a node service: names the agent it needs, and does not ask the panel host for IPs", async () => {
    renderWithProviders(<PortMappingsCard serviceId={3} svc={svc({ serverId: 4, portMappings: [udp] })} />);
    expect(screen.getByText(/published on the node's own addresses/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save mappings' }));
    await waitFor(() => expect(api.services.update).toHaveBeenCalledWith(3, { portMappings: [udp] }));
    expect(api.services.hostAddresses).not.toHaveBeenCalled();
  });

  it('is hidden for compose and pm2 services and on a panel without the field', () => {
    for (const s of [svc({ type: 'compose' }), svc({ type: 'pm2' }), svc({ portMappings: undefined }), null]) {
      const { unmount } = renderWithProviders(<PortMappingsCard serviceId={3} svc={s} />);
      expect(screen.queryByText(/Port Mappings/)).not.toBeInTheDocument();
      unmount();
    }
  });
});
