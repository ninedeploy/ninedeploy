/**
 * Tiny YAML highlighter for the Manifest Creator preview.
 *
 * The preview is a *generated* file from a fixed emitter (`formatManifestYaml`),
 * so a full YAML grammar would be overkill. This line-based tokenizer covers
 * what the emitter produces — comments, `key:` pairs (including keys that
 * follow a `- ` list dash), quoted strings, numbers and booleans — and
 * degrades to plain text for anything else, which keeps the render honest
 * for hand-pasted shapes too.
 */

export type YamlTokenKind = 'comment' | 'key' | 'string' | 'number' | 'boolean' | 'plain';

export interface YamlToken {
  text: string;
  kind: YamlTokenKind;
}

export interface YamlLine {
  tokens: YamlToken[];
}

/** Tailwind classes per token kind — kept next to the tokenizer so the
 *  colors stay consistent with the page's dark surface. */
export const YAML_TOKEN_CLASS: Record<YamlTokenKind, string> = {
  comment: 'text-slate-500 italic',
  key: 'text-sky-300',
  string: 'text-emerald-300',
  number: 'text-amber-300',
  boolean: 'text-violet-300',
  plain: 'text-slate-200',
};

const BOOLEAN_VALUES = new Set(['true', 'false', 'null', '~']);

/**
 * Tokenize a YAML document into highlighted lines.
 *
 * Per line: a leading `#` (after optional indent) makes the whole line a
 * comment; otherwise an `indent key:` prefix is emitted as key tokens and
 * the remainder after the colon is classified as string / number / boolean
 * / plain. A trailing ` #…` outside quotes is split off as a comment.
 */
export function highlightYaml(yaml: string): YamlLine[] {
  return yaml.split('\n').map((line) => ({ tokens: tokenizeLine(line) }));
}

function tokenizeLine(line: string): YamlToken[] {
  // Blank lines carry no tokens — the render still emits the newline.
  if (line === '') return [];

  const trimmed = line.trimStart();

  // Whole-line comment (the emitter's header block lands here).
  if (trimmed.startsWith('#')) {
    return [{ text: line, kind: 'comment' }];
  }

  // List item: `- host: "…"` or `- "value"`. The dash is plain; the rest
  // recurses so a list of mappings keeps its per-key highlighting.
  const listMatch = /^(\s*)(-\s+)(.*)$/.exec(line);
  if (listMatch) {
    const [, indent, dash, rest] = listMatch;
    if (!dash) return [{ text: line, kind: 'plain' }];
    return [
      ...(indent ? [{ text: indent, kind: 'plain' as const }] : []),
      { text: dash, kind: 'plain' },
      ...tokenizeLine(rest ?? ''),
    ];
  }

  // Key: `indent` + `name` + `:`. The emitter only writes plain scalar keys.
  const keyMatch = /^(\s*)([A-Za-z0-9_.\-"']+\s?):(.*)$/.exec(line);
  if (keyMatch) {
    const [, indent, name, rest] = keyMatch;
    // `indent` may legitimately be '' (list-item recursion); only a missing
    // name group cannot happen when the regex matched.
    if (!name) return [{ text: line, kind: 'plain' }];
    const tokens: YamlToken[] = [];
    if (indent) tokens.push({ text: indent, kind: 'plain' });
    tokens.push({ text: name, kind: 'key' });
    tokens.push({ text: ':', kind: 'key' });
    tokens.push(...tokenizeValue(rest ?? ''));
    return tokens;
  }

  return [{ text: line, kind: 'plain' }];
}

function tokenizeValue(rest: string): YamlToken[] {
  if (rest === '') return [];
  // Preserve the whitespace after the colon for visual parity.
  const leading = /^\s+/.exec(rest)?.[0] ?? '';
  const value = rest.slice(leading.length);
  const out: YamlToken[] = [];
  if (leading) out.push({ text: leading, kind: 'plain' });
  out.push(...splitTrailingComment(value));
  return out;
}

/** Split `value  # comment` into the scalar part and the comment part. */
function splitTrailingComment(value: string): YamlToken[] {
  // Only unquoted ` #` starts a comment; quoted strings keep their `#`.
  if (!value.startsWith('"') && !value.startsWith("'")) {
    const hashIndex = value.indexOf(' #');
    if (hashIndex !== -1) {
      return [
        ...tokenizeScalar(value.slice(0, hashIndex)),
        { text: value.slice(hashIndex), kind: 'comment' },
      ];
    }
  }
  return tokenizeScalar(value);
}

function tokenizeScalar(value: string): YamlToken[] {
  if (value === '') return [];
  if (value.startsWith('"') || value.startsWith("'")) {
    return [{ text: value, kind: 'string' }];
  }
  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    return [{ text: value, kind: 'number' }];
  }
  if (BOOLEAN_VALUES.has(value)) {
    return [{ text: value, kind: 'boolean' }];
  }
  return [{ text: value, kind: 'plain' }];
}
