/** A typed HTTP error. The global error handler turns it into the API error envelope. */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const badRequest = (message = 'Bad request', code = 'bad_request') =>
  new HttpError(400, code, message);
export const unauthorized = (message = 'Unauthorized', code = 'unauthorized') =>
  new HttpError(401, code, message);
export const forbidden = (message = 'Forbidden') => new HttpError(403, 'forbidden', message);
export const notFound = (message = 'Not found') => new HttpError(404, 'not_found', message);
export const conflict = (message = 'Conflict') => new HttpError(409, 'conflict', message);
export const unprocessable = (message = 'Unprocessable entity', code = 'unprocessable_entity') =>
  new HttpError(422, code, message);

/**
 * Parse a route-param id into a positive integer. Throws 400 (not 404) on
 * malformed input so an id like `abc` produces a clear validation error
 * instead of silently becoming NaN and yielding a misleading "not found".
 */
export const parseId = (value: string, message = 'Invalid id parameter'): number => {
  // r260: canonical decimal only. `Number()` alone accepted `1e0`, `0x1`,
  // `+1` and `1.0`, which let a path name a resource in a form the API-token
  // scope classifier did not recognise (see ROUTE_SCOPE_OVERRIDES).
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) throw badRequest(message, 'invalid_id');
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw badRequest(message, 'invalid_id');
  return n;
};
