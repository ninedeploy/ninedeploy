import { STREAM_FRAME_TYPE } from './agentFrameCipher.js';

/**
 * G5.8 node tunnels: what the panel (lib/nodeTunnel.ts) and the agent
 * (agentOps/tunnels.ts) agree on. The frame numbers are the stream channel's.
 */

/** Agent WebSocket route of the tunnel channel. */
export const TUNNEL_PATH = '/agent/tunnel';
/** Subprotocol carrying the channel id (`ninedeploy.agent-tunnel.<channelId>`). */
export const TUNNEL_PROTOCOL_PREFIX = 'ninedeploy.agent-tunnel.';

export const TUNNEL_FRAME = {
  /** TCP bytes, either way. */
  data: STREAM_FRAME_TYPE.data,
  /** The sender is closing the tunnel; payload: an optional UTF-8 reason. */
  close: STREAM_FRAME_TYPE.close,
  /** Flow control, either way: stop sending data frames. */
  pause: STREAM_FRAME_TYPE.pause,
  /** Flow control, either way: send again. The panel's first frame is always one: it authenticates the channel. */
  resume: STREAM_FRAME_TYPE.resume,
} as const;

/** The frame types a tunnel opener accepts. */
export const TUNNEL_FRAME_TYPES: ReadonlySet<number> = new Set<number>(Object.values(TUNNEL_FRAME));
