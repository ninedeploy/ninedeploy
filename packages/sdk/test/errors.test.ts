import { describe, expect, it } from 'vitest';
import { NineDeployError } from '../src/errors.js';

describe('NineDeployError', () => {
  it('stores status, code, message and details', () => {
    const err = new NineDeployError(404, 'not_found', 'nope', { id: 3 });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('NineDeployError');
    expect(err.status).toBe(404);
    expect(err.code).toBe('not_found');
    expect(err.message).toBe('nope');
    expect(err.details).toEqual({ id: 3 });
  });

  it('leaves details undefined when omitted', () => {
    const err = new NineDeployError(500, 'boom', 'kaboom');
    expect(err.details).toBeUndefined();
  });

  describe('fromBody', () => {
    it('maps a full error envelope', () => {
      const err = NineDeployError.fromBody(400, {
        error: { code: 'bad_request', message: 'Invalid', details: { field: 'name' } },
      });
      expect(err.status).toBe(400);
      expect(err.code).toBe('bad_request');
      expect(err.message).toBe('Invalid');
      expect(err.details).toEqual({ field: 'name' });
    });

    it('maps an envelope without details', () => {
      const err = NineDeployError.fromBody(400, { error: { code: 'bad_request', message: 'Invalid' } });
      expect(err.details).toBeUndefined();
    });

    it('falls back to unknown_error when the error object is missing', () => {
      const err = NineDeployError.fromBody(500, {});
      expect(err.status).toBe(500);
      expect(err.code).toBe('unknown_error');
      expect(err.message).toBe('Request failed with status 500');
      expect(err.details).toBeUndefined();
    });

    it('falls back per-field when the envelope lacks a code', () => {
      const err = NineDeployError.fromBody(500, { error: { message: 'only a message' } });
      expect(err.code).toBe('unknown_error');
      expect(err.message).toBe('only a message');
    });

    it('falls back for non-object bodies', () => {
      for (const body of ['oops', 42, null, undefined]) {
        const err = NineDeployError.fromBody(502, body);
        expect(err.status).toBe(502);
        expect(err.code).toBe('unknown_error');
        expect(err.message).toBe('Request failed with status 502');
        expect(err.details).toBeUndefined();
      }
    });
  });
});
