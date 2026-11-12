/**
 * Tokenize a hook command line. Hooks are documented as ONE argv-style
 * command whose compound form is `sh -c "a && b"` — that only works if
 * quoting is honoured; a plain whitespace split leaves the quote bytes in
 * argv (`sh -c '"a'` → "command not found"). Rules: single quotes are fully
 * literal; inside double quotes `\` escapes `"` and `\`; outside quotes `\`
 * escapes the next char; unterminated quotes run to end of input.
 */
export function splitHookCommand(cmd: string): string[] {
  const argv: string[] = [];
  let cur = '';
  let open = false; // the current token exists — keeps `''`/`""` as empty args
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '\\' && (cmd[i + 1] === '"' || cmd[i + 1] === '\\')) cur += cmd[++i];
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      open = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (open) {
        argv.push(cur);
        cur = '';
        open = false;
      }
      continue;
    }
    if (ch === '\\' && i + 1 < cmd.length) {
      cur += cmd[++i];
      open = true;
      continue;
    }
    cur += ch;
    open = true;
  }
  if (open) argv.push(cur);
  return argv;
}
