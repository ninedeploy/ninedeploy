/**
 * Minimal hand-rolled XML helpers (zero dependencies).
 *
 * Only as much of XML as the Namecheap DNS API actually uses:
 *   - `<ApiResponse Status="OK">…</ApiResponse>` with a fixed attribute
 *     vocabulary, child `<Domain Name="…" />` self-closing elements, and
 *     child `<Host HostId Name Type Address TTL />` self-closing elements.
 *   - `<Error Number="…">human text</Error>` blocks carrying a numeric
 *     code and a free-text message.
 *
 * The parser is intentionally narrow: it does NOT try to be a general
 * XML 1.0 implementation. It walks the input once with a single
 * `RegExp.exec` cursor, throws on anything it doesn't recognise, and
 * returns plain JS objects so the Namecheap driver doesn't have to
 * pull in a real parser for what is essentially a config dump.
 *
 * The same shape is reused by `lib/saml.ts` for the SSO IdP metadata
 * flow; both callers only need attribute extraction, never namespaces
 * or entity-resolution gymnastics.
 */

export interface XmlElement {
  /** Local name (no namespace prefix; Namecheap responses don't use them). */
  name: string;
  /** Attribute key → value. Both are decoded with `decodeXmlEntities`. */
  attrs: Record<string, string>;
  /** Concatenated text content between the opening and closing tag. May
   *  be empty for self-closing elements. CDATA / nested mixed content
   *  is out of scope. */
  text: string;
  /** Direct children, in document order. */
  children: XmlElement[];
}

/** Decode the five XML predefined entities. Numeric character refs are
 *  intentionally not handled — Namecheap's responses never emit them. */
export function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Encode the same five entities. Used when the Namecheap driver has
 *  to put a user-supplied string (a host name, a record value) back
 *  into a request body — Namecheap's `setHosts` is form-encoded so
 *  this is enough. */
export function encodeXmlEntities(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const TAG_RE = /<!--[\s\S]*?-->|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[A-Za-z_][\w:.-]*\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
// TAG_RE above matches attribute values in either quote style, so both must be
// extracted here — a single-quoted attr that only TAG_RE recognised used to be
// silently dropped (empty attrs) instead of parsed.
const ATTR_RE = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** Parse a Namecheap-shaped XML document. Throws on malformed input. */
export function parseXml(input: string): XmlElement {
  TAG_RE.lastIndex = 0;
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  let cursor = 0;
  let textStart = 0;
  while (cursor < input.length) {
    TAG_RE.lastIndex = cursor;
    const m = TAG_RE.exec(input);
    if (!m) {
      // No more tags. Whatever trailing text remains belongs to the
      // current top of the stack.
      appendText(stack, input.slice(textStart));
      break;
    }
    if (m[0].startsWith('<!--')) {
      // Comment — first flush any text that accumulated BEFORE it (it
      // belongs to the current element), then skip past the comment.
      // Advancing `textStart` to the comment's end keeps the comment
      // itself out of the text buffer.
      appendText(stack, input.slice(textStart, m.index));
      cursor = TAG_RE.lastIndex;
      textStart = cursor;
      continue;
    }
    // Flush any text that appeared between the previous tag and this one.
    appendText(stack, input.slice(textStart, m.index));
    const closing = m[1] === '/';
    const tagName = m[2]!;
    const rawAttrs = m[3] ?? '';
    const selfClose = m[4] === '/';
    if (closing) {
      // Pop the matching opener.
      const top = stack.pop();
      if (!top || top.name !== tagName) {
        throw new Error(`XML parse error: unexpected </${tagName}>`);
      }
    } else {
      const attrs: Record<string, string> = {};
      ATTR_RE.lastIndex = 0;
      let am = ATTR_RE.exec(rawAttrs);
      while (am) {
        attrs[am[1]!] = decodeXmlEntities(am[2] ?? am[3] ?? '');
        am = ATTR_RE.exec(rawAttrs);
      }
      const el: XmlElement = { name: tagName, attrs, text: '', children: [] };
      if (stack.length === 0) {
        if (root) throw new Error(`XML parse error: multiple roots (saw <${tagName}>)`);
        root = el;
      } else {
        stack[stack.length - 1]!.children.push(el);
      }
      if (!selfClose) {
        stack.push(el);
      }
    }
    cursor = TAG_RE.lastIndex;
    textStart = cursor;
  }
  if (stack.length > 0) {
    throw new Error(`XML parse error: unclosed <${stack[stack.length - 1]!.name}>`);
  }
  if (!root) throw new Error('XML parse error: empty document');
  return root;
}

/** Find the first direct child of `parent` whose name is `name`. */
export function findChild(parent: XmlElement, name: string): XmlElement | undefined {
  return parent.children.find((c) => c.name === name);
}

/** All direct children with the given name. */
export function findChildren(parent: XmlElement, name: string): XmlElement[] {
  return parent.children.filter((c) => c.name === name);
}

function appendText(stack: XmlElement[], text: string): void {
  if (!text) return;
  const top = stack[stack.length - 1];
  if (!top) return;
  top.text += decodeXmlEntities(text);
}
