import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ServerListEntry } from '@ninedeploy/sdk';
import { DeploymentSupport } from '../src/components/DeploymentSupport.js';

describe('deployment availability', () => {
  const canaryCaps = ['proxy.traffic', 'proxy.routingAck', 'docker.recovery', 'docker.probe', 'docker.readiness'];
  it('reports node canary only when every required capability is advertised', () => {
    render(<DeploymentSupport node={{ name: 'edge-1', agent: { version: '0.18.0', checkedAt: null, capabilities: canaryCaps } } as ServerListEntry} />);
    expect(within(screen.getByText('Canary releases').parentElement!).getByText('Available')).toBeInTheDocument();
    expect(screen.getByText(/one replica, HTTP readiness, a domain and no published host ports/)).toBeInTheDocument();
  });
  it.each(canaryCaps)('refuses incomplete node canary support without %s', missing => {
    render(<DeploymentSupport node={{ name: 'edge-1', agent: { version: '0.18.0', checkedAt: null, capabilities: canaryCaps.filter(cap => cap !== missing) } } as ServerListEntry} />);
    expect(within(screen.getByText('Canary releases').parentElement!).getByText('Unavailable')).toBeInTheDocument();
  });
  it.each([true, false])('reports the node file browser from its advertised capability: %s', supported => {
    render(<DeploymentSupport node={{ name: 'edge-1', features: { containerTools: supported } } as ServerListEntry} />);
    expect(within(screen.getByText('Container file browser').parentElement!).getByText(supported ? 'Available' : 'Unavailable')).toBeInTheDocument();
  });
  it('shows the selected node capabilities and the remaining panel-only features', () => {
    render(<DeploymentSupport node={{ name: 'edge-1', features: { readinessProbe: true, logDrains: false } } as ServerListEntry} />);
    expect(screen.getByText('Docker features on edge-1')).toBeInTheDocument();
    expect(within(screen.getByText('HTTP/TCP readiness').parentElement!).getByText('Available')).toBeInTheDocument();
    expect(within(screen.getByText('Log drains').parentElement!).getByText('Unavailable')).toBeInTheDocument();
    expect(within(screen.getByText('Autoscaling').parentElement!).getByText('Unavailable')).toBeInTheDocument();
  });

  it('keeps capabilities omitted by an older panel unknown', () => {
    render(<DeploymentSupport node={{ name: 'older-node' } as ServerListEntry} />);
    expect(screen.getAllByText('Not reported')).toHaveLength(5);
    expect(within(screen.getByText('Container file browser').parentElement!).getByText('Not reported')).toBeInTheDocument();
  });
});
