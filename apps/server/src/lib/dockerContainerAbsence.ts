/** A missing result must identify exactly the requested container and contain no other diagnostics. */
export function confirmsMissingContainer(lines: string[], reference: string): boolean {
  if (lines.length !== 1) return false;
  const line = lines[0]!.trim();
  return line === `Error: No such object: ${reference}` ||
    line === `Error: No such container: ${reference}` ||
    line === `Error response from daemon: No such container: ${reference}`;
}
