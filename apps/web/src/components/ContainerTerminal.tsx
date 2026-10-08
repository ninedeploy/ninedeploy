import { TerminalPanel } from './terminal/TerminalPanel.js';

interface ContainerTerminalProps {
  serviceId: number;
  serviceName?: string;
  /** 1-based replica; omitted = the primary container. */
  replica?: number;
  /** A node the service runs on (fan-out target); omitted = its primary placement. */
  serverId?: number;
  onClose?: () => void;
}

/**
 * A shell into a service's container. 0.15: a thin wrapper over the
 * protocol-v1 `TerminalPanel` (`/v1/terminals`, real TTY with resize); the
 * legacy `/v1/services/:id/exec` socket is no longer used by the panel.
 */
export function ContainerTerminal({ serviceId, serviceName, replica, serverId, onClose }: ContainerTerminalProps) {
  return (
    <TerminalPanel
      target={{
        kind: 'service',
        serviceId,
        ...(replica !== undefined ? { replica } : {}),
        ...(serverId !== undefined ? { serverId } : {}),
      }}
      title={serviceName ? `${serviceName} · shell` : 'container shell'}
      onClose={onClose}
    />
  );
}
