export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export class NineDeployError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'NineDeployError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static fromBody(status: number, body: unknown): NineDeployError {
    const err = (body as ApiErrorBody | null)?.error;
    return new NineDeployError(
      status,
      err?.code ?? 'unknown_error',
      err?.message ?? `Request failed with status ${status}`,
      err?.details,
    );
  }
}
