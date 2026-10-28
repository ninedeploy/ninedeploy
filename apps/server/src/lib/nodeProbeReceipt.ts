/** Accept one successful probe receipt for the requested protocol. */
export function confirmedNodeProbe(lines: readonly string[], exitCode: number, protocol: 'http' | 'tcp'): boolean {
  const frames = lines.filter(line => line.startsWith('ND-PROBE '));
  if (exitCode !== 0 || frames.length !== 1 || Buffer.byteLength(frames[0]!) > 16_384) return false;
  try {
    const value: unknown = JSON.parse(frames[0]!.slice(9));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return record.ready === true && record.protocol === protocol &&
      (protocol !== 'http' || typeof record.status === 'number' && Number.isInteger(record.status) && record.status >= 200 && record.status < 400);
  } catch {
    return false;
  }
}
