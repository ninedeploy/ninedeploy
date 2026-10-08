import type { WebsocketPluginOptions } from '@fastify/websocket';

/**
 * Server options for `@fastify/websocket` (0.15 D6, owner decision O6).
 *
 * 1. `maxPayload`: `ws` defaults to 100 MiB, and a frame is buffered while the
 *    handler is still awaiting `resolveUser` — pre-auth memory any client can
 *    spend. No first-party client sends more than 64 KiB in one frame, so the
 *    cap is 1 MiB; a larger frame closes the socket with 1009.
 *
 * 2. `handleProtocols`: by default `ws` selects the FIRST offered subprotocol
 *    and echoes it in the 101 response — for today's clients that is
 *    `ninedeploy.bearer.<token>`. A client that also offers a non-credential
 *    protocol (`ninedeploy`, `ninedeploy.terminal.v1`) now gets that one back
 *    instead, so the credential is not echoed. A client offering ONLY the
 *    bearer still gets the bearer back: RFC 6455 clients (browsers, `ws`, the
 *    CLI) fail a handshake that offered protocols and selected none, so
 *    dropping the echo for them would break every existing client.
 */
export const WEBSOCKET_MAX_PAYLOAD = 1024 * 1024;

/** Subprotocol prefixes that carry a credential and are never preferred. */
export const CREDENTIAL_PROTOCOL_PREFIXES = ['ninedeploy.bearer.', 'ninedeploy.ticket.'] as const;

const carriesCredential = (protocol: string) => CREDENTIAL_PROTOCOL_PREFIXES.some((p) => protocol.startsWith(p));

/** The subprotocol to select: the first non-credential one, else the first offered. */
export function selectWebsocketProtocol(protocols: Set<string>): string | false {
  for (const protocol of protocols) {
    if (!carriesCredential(protocol)) return protocol;
  }
  const first = protocols.values().next();
  return first.done ? false : first.value;
}

export const websocketServerOptions: NonNullable<WebsocketPluginOptions['options']> = {
  maxPayload: WEBSOCKET_MAX_PAYLOAD,
  handleProtocols: (protocols: Set<string>) => selectWebsocketProtocol(protocols),
};
