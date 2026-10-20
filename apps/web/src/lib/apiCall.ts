import { NineDeployError } from '@ninedeploy/sdk';
import { authedFetch } from './api.js';

/**
 * A typed JSON call over `authedFetch` (bearer + refresh-on-401, same as the
 * SDK client) with the SDK's error shape, so a failed request carries the
 * server's message. For routes the panel needs before the SDK has a method.
 */
export async function apiCall<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await authedFetch(path, init);
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!res.ok) {
    if (parsed === undefined) throw new NineDeployError(res.status, 'http_error', `Request failed (${res.status})`);
    throw NineDeployError.fromBody(res.status, parsed);
  }
  if (parsed === undefined) {
    if (text === '') return {} as T;
    throw new NineDeployError(res.status, 'invalid_response', `Expected JSON but received a non-JSON body (status ${res.status})`);
  }
  return parsed as T;
}
