/** 0.15 terminal protocol v1 (DESIGN §1.4): frame decoding, the handshake, the Origin rule. */
import { describe, expect, it } from 'vitest';
import { TERMINAL_FRAME_MAX_BYTES } from '@ninedeploy/schemas';
import {
  attachHandshake,
  encodeServerMessage,
  frameBytes,
  offeredProtocols,
  originAllowed,
  parseClientFrame,
} from '../../src/lib/terminalProtocol.js';

describe('parseClientFrame', () => {
  it('binary frames are stdin, verbatim', () => {
    expect(parseClientFrame(Buffer.from('ls\r'), true)).toEqual({ kind: 'stdin', data: Buffer.from('ls\r') });
    expect(parseClientFrame(new Uint8Array([1, 2]).buffer, true)).toEqual({ kind: 'stdin', data: Buffer.from([1, 2]) });
    expect(parseClientFrame([Buffer.from('a'), Buffer.from('b')], true)).toEqual({ kind: 'stdin', data: Buffer.from('ab') });
  });

  it('text frames are JSON control messages', () => {
    expect(parseClientFrame(Buffer.from('{"t":"resize","cols":120,"rows":40}'), false)).toEqual({ kind: 'resize', cols: 120, rows: 40 });
    expect(parseClientFrame('{"t":"ping"}', false)).toEqual({ kind: 'ping' });
  });

  it('refuses bad resize values and anything that is not a control message (never written to the shell)', () => {
    for (const bad of [
      '{"t":"resize","cols":9,"rows":40}',
      '{"t":"resize","cols":501,"rows":40}',
      '{"t":"resize","cols":80,"rows":4}',
      '{"t":"resize","cols":80,"rows":201}',
      '{"t":"resize","cols":80.5,"rows":24}',
      '{"t":"resize","cols":80,"rows":24,"x":1}',
      '{"t":"stdin","data":"rm -rf /"}',
    ]) {
      expect(parseClientFrame(bad, false), bad).toMatchObject({ kind: 'invalid', reason: 'unknown or malformed control message' });
    }
    expect(parseClientFrame('ls -la', false)).toMatchObject({ kind: 'invalid', reason: 'text frames must be JSON control messages' });
  });

  it('a frame over 64 KiB is too large, binary or text', () => {
    const big = Buffer.alloc(TERMINAL_FRAME_MAX_BYTES + 1);
    expect(parseClientFrame(big, true)).toEqual({ kind: 'too_large' });
    expect(parseClientFrame(big, false)).toEqual({ kind: 'too_large' });
    expect(parseClientFrame(Buffer.alloc(TERMINAL_FRAME_MAX_BYTES), true)).toMatchObject({ kind: 'stdin' });
  });

  it('frameBytes normalises every ws payload type', () => {
    expect(frameBytes(new Uint16Array([0x4141])).length).toBe(2);
    expect(frameBytes(42).toString()).toBe('42');
  });
});

describe('the attach handshake', () => {
  const ticket = 'A'.repeat(43);

  it('needs the v1 protocol and a well-formed ticket subprotocol', () => {
    expect(attachHandshake(`ninedeploy.terminal.v1, ninedeploy.ticket.${ticket}`)).toEqual({ protocol: true, ticket });
    expect(attachHandshake([`ninedeploy.ticket.${ticket}`, 'ninedeploy.terminal.v1'])).toEqual({ protocol: true, ticket });
    expect(attachHandshake(`ninedeploy.ticket.${ticket}`)).toEqual({ protocol: false, ticket });
    expect(attachHandshake('ninedeploy.terminal.v1')).toEqual({ protocol: true, ticket: null });
    expect(attachHandshake('ninedeploy.terminal.v1, ninedeploy.ticket.short')).toEqual({ protocol: true, ticket: null });
    expect(attachHandshake('ninedeploy.terminal.v1, ninedeploy.ticket.has spaces in it here')).toMatchObject({ ticket: null });
    expect(attachHandshake(undefined)).toEqual({ protocol: false, ticket: null });
    expect(offeredProtocols(' a , ,b ')).toEqual(['a', 'b']);
  });

  it('encodes server messages as JSON text', () => {
    expect(JSON.parse(encodeServerMessage({ t: 'exit', code: 0, reason: 'shell_exited' }))).toEqual({ t: 'exit', code: 0, reason: 'shell_exited' });
  });
});

describe('originAllowed', () => {
  const allowed = ['https://panel.example.com', 'http://localhost:5173/'];

  it('allows a panel origin (case and trailing slash insensitive) and a missing Origin (CLI)', () => {
    expect(originAllowed('https://panel.example.com', allowed)).toBe(true);
    expect(originAllowed('HTTPS://Panel.Example.com/', allowed)).toBe(true);
    expect(originAllowed('http://localhost:5173', allowed)).toBe(true);
    expect(originAllowed(undefined, allowed)).toBe(true);
    expect(originAllowed('', allowed)).toBe(true);
    expect(originAllowed([], allowed)).toBe(true);
  });

  it('refuses any other origin, including the opaque "null" origin', () => {
    expect(originAllowed('https://evil.example', allowed)).toBe(false);
    expect(originAllowed('https://panel.example.com.evil.example', allowed)).toBe(false);
    expect(originAllowed('null', allowed)).toBe(false);
    expect(originAllowed(['https://evil.example'], allowed)).toBe(false);
  });
});
