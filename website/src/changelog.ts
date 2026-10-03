/**
 * The release history, straight from the repository's CHANGELOG.md.
 *
 * The page used to carry its own hand-written copy of every release, and
 * nothing in the release script touched it — so it froze at 0.7.2 while
 * the product shipped twenty more versions. Parsing the one changelog the
 * release process already maintains makes that drift impossible, the same
 * way hub.ts derives every template count from the server registry.
 */

export interface ChangelogGroup {
  /** The `### Added` / `### Fixed` / … heading, or "Notes" for loose prose. */
  title: string;
  items: string[];
}

export interface Release {
  version: string;
  date: string;
  /** The `>` quote under the version heading, when the release has one. */
  tagline: string;
  groups: ChangelogGroup[];
}

const VERSION_HEADING = /^## \[([^\]]+)\](?:\s*-\s*(\S+))?/;

/** Joins wrapped source lines; a hyphen before a lowercase continuation is
 * a word split by the 80-column wrap ("upstream-\ndrift"), not a dash. */
const squash = (parts: string[]) => {
  let out = "";
  for (const p of parts) {
    if (!out) out = p;
    else if (out.endsWith("-") && /^[a-z]/.test(p)) out += p;
    else out += ` ${p}`;
  }
  return out.replace(/\s+/g, " ").trim();
};

export function parseChangelog(md: string): Release[] {
  const releases: Release[] = [];
  let release: Release | null = null;
  let group: ChangelogGroup | null = null;
  // The bullet or paragraph being accumulated across wrapped lines.
  let item: string[] = [];
  let itemIsBullet = false;
  let afterBlank = false;
  let quote: string[] = [];

  const flush = () => {
    const text = squash(item);
    item = [];
    itemIsBullet = false;
    if (!release || !text) return;
    if (!group) {
      group = { title: "Notes", items: [] };
      release.groups.push(group);
    }
    group.items.push(text);
  };

  const closeQuote = () => {
    const text = squash(quote);
    quote = [];
    // Only the quote that opens a release is its tagline; later quotes are prose.
    if (!release || !text) return;
    if (!release.tagline && release.groups.length === 0) release.tagline = text;
    else item.push(text);
  };

  for (const line of md.split(/\r?\n/)) {
    const heading = VERSION_HEADING.exec(line);
    if (heading) {
      closeQuote();
      flush();
      release = { version: heading[1]!, date: heading[2] ?? "", tagline: "", groups: [] };
      releases.push(release);
      group = null;
      afterBlank = false;
      continue;
    }
    if (!release) continue; // file preamble

    if (line.trim() === "") {
      afterBlank = true;
      continue;
    }
    const indented = /^\s/.test(line);
    const blank = afterBlank;
    afterBlank = false;

    if (line.startsWith(">")) {
      flush();
      quote.push(line.replace(/^>\s?/, ""));
      continue;
    }
    closeQuote();

    if (line.startsWith("### ")) {
      flush();
      group = { title: line.slice(4).trim(), items: [] };
      release.groups.push(group);
      continue;
    }
    if (/^---\s*$/.test(line)) {
      flush();
      continue;
    }
    if (line.startsWith("- ") || line.startsWith("* ")) {
      flush();
      item.push(line.slice(2));
      itemIsBullet = true;
      continue;
    }
    // Wrapped lines and nested bullets fold into the open item. After a
    // blank line only an indented line still belongs to an open bullet;
    // anything else starts a new paragraph.
    if (blank && !(itemIsBullet && indented)) flush();
    item.push(line.trim());
  }
  closeQuote();
  flush();

  // An empty "Unreleased" placeholder should not lead the page.
  return releases.filter((r) => r.groups.some((g) => g.items.length > 0));
}
