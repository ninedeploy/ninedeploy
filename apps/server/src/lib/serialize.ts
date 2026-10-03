/**
 * Shared response-serialization helpers. Route modules used to hand-roll a
 * `serialize()` per module with the same Date→ISO mapping over and over;
 * these utilities keep that boilerplate in one place.
 */

/** Convert a nullable DB date column to an ISO string (null passes through). */
export function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

/** Date-only ISO prefix (`YYYY-MM-DD`) for expiry columns. */
export function isoDate(date: Date | null | undefined): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}

/**
 * Standard list envelope: `{ items, total }`. `total` defaults to the item
 * count so unpaginated lists stay honest without an extra COUNT query.
 */
export function listResponse<T>(items: T[], total?: number): { items: T[]; total: number } {
  return { items, total: total ?? items.length };
}
