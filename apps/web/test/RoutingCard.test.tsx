import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const apiMock = vi.hoisted(() => ({ api: { services: { routing: vi.fn() } }, authedFetch: vi.fn() }));
vi.mock('../src/lib/api.js', () => apiMock);

import { RoutingCard } from '../src/routes/service/RoutingCard.js';

function renderCard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <RoutingCard serviceId={4} />
    </QueryClientProvider>,
  );
}

describe('RoutingCard', () => {
  beforeEach(() => apiMock.api.services.routing.mockReset());
  afterEach(cleanup);

  it('refreshes a refused routing view and keeps refresh disabled until the new observation arrives', async () => {
    let answer!: (value: unknown) => void;
    apiMock.api.services.routing.mockRejectedValueOnce(new Error('Routing unavailable'))
      .mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    renderCard();
    expect(await screen.findByText('Could not load the routing view.')).toBeTruthy();
    const refresh = screen.getByRole('button', { name: 'Refresh routing' });
    await userEvent.click(refresh);
    expect(refresh).toBeDisabled();
    expect(apiMock.api.services.routing).toHaveBeenCalledTimes(2);
    expect(apiMock.api.services.routing).toHaveBeenLastCalledWith(4);
    answer({ live: true, liveNote: null, container: { name: 'web-12', state: 'running', health: 'healthy', ip: null },
      http: [{ domainId: 7, hostname: 'web.example.test', path: '/app', ssl: false, router: null, upstreams: [], verdict: 'warn', note: null }],
      ports: [{ protocol: 'tcp', hostIp: '2001:db8::1', hostPort: 5432, hostPortEnd: null, containerPort: 5432,
        via: 'portproxy', allowFrom: ['192.0.2.0/24'], bound: [], verdict: 'ok', note: null }],
    });
    expect(await screen.findByText('web-12')).toBeTruthy();
    expect(screen.queryByText('Could not load the routing view.')).toBeNull();
    expect(refresh).toBeEnabled();
    expect(screen.getByText('healthy')).toBeTruthy();
    expect(screen.getByText('http://web.example.test/app')).toBeTruthy();
    expect(screen.getByText('no router')).toBeTruthy();
    expect(screen.getByText('[2001:db8::1]:5432/tcp')).toBeTruthy();
    expect(screen.getByText('allow-list proxy')).toBeTruthy();
    expect(screen.getByText('Allowed from 192.0.2.0/24')).toBeTruthy();
  });

  it('shows every domain and host port hop with its verdict', async () => {
    apiMock.api.services.routing.mockResolvedValue({
      live: true,
      liveNote: null,
      container: { name: 'sip-12', state: 'running', health: null, ip: '172.18.0.5' },
      http: [{ domainId: 3, hostname: 'sip.example.com', path: null, ssl: true, router: 'sip_3', upstreams: ['http://sip-11:8080'], verdict: 'error',
        note: 'Traefik still routes to http://sip-11:8080, not the live runtime sip-12' }],
      ports: [
        { protocol: 'udp', hostIp: null, hostPort: 5060, hostPortEnd: null, containerPort: 5060, via: 'docker', allowFrom: null,
          bound: ['0.0.0.0:5060/udp'], verdict: 'ok', note: 'Docker DNAT: datagrams keep the client\'s source IP (SIP/RTP safe)' },
        { protocol: 'udp', hostIp: '203.0.113.7', hostPort: 10000, hostPortEnd: 10002, containerPort: 10000, via: 'docker', allowFrom: null,
          bound: [], verdict: 'error', note: '1 of 3 host port(s) are not bound — redeploy to publish them' },
      ],
    });
    renderCard();

    expect(await screen.findByText('https://sip.example.com')).toBeTruthy();
    expect(apiMock.api.services.routing).toHaveBeenCalledWith(4);
    expect(screen.getByText('http://sip-11:8080')).toBeTruthy();
    expect(screen.getByText(/still routes to/)).toBeTruthy();
    expect(screen.getByText('*:5060/udp')).toBeTruthy();
    expect(screen.getByText('203.0.113.7:10000-10002/udp')).toBeTruthy();
    expect(screen.getByText('container 10000-10002/udp')).toBeTruthy();
    expect(screen.getByText(/1 of 3 host port/)).toBeTruthy();
    expect(screen.getAllByText('error')).toHaveLength(2);
    expect(screen.getByText('sip-12')).toBeTruthy();
  });

  it('says when only the configuration of a node service is shown', async () => {
    apiMock.api.services.routing.mockResolvedValue({ live: false, liveNote: 'This service runs on a node', container: null, http: [], ports: [] });
    renderCard();
    expect(await screen.findByText('This service runs on a node')).toBeTruthy();
    expect(screen.getByText('No domains.')).toBeTruthy();
    expect(screen.getByText('No host ports are published.')).toBeTruthy();
  });
});
