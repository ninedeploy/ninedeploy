/** Merge HTTP fields with later sources winning, independent of name casing. */
export function mergeHttpHeaders(
  ...sources: Array<Readonly<Record<string, string>> | null | undefined>
): Record<string, string> {
  const merged: Record<string, string> = Object.create(null);
  const spellings = new Map<string, string>();
  for (const source of sources) {
    for (const [name, value] of Object.entries(source ?? {})) {
      const key = name.toLowerCase();
      const previous = spellings.get(key);
      if (previous !== undefined) delete merged[previous];
      merged[name] = value;
      spellings.set(key, name);
    }
  }
  return merged;
}
