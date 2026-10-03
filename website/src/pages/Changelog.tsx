import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import raw from "../../../CHANGELOG.md?raw";
import { parseChangelog, type Release } from "../changelog";

const releases = parseChangelog(raw);
const shipped = releases.filter((r) => r.version !== "Unreleased");
const current = shipped[0]?.version;

/** Releases shown expanded; everything older sits behind a disclosure. */
const EXPANDED = 6;

/** Inline markdown the changelog actually uses: **bold**, `code`, *em*, [text](url). */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re =
    /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|(?<![\w*])\*([^*\s][^*]*?)\*(?![\w*])/g;
  let last = 0;
  let m = re.exec(text);
  while (m) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = out.length;
    if (m[1] !== undefined)
      out.push(
        <strong key={key} className="font-bold text-ink dark:text-zinc-100">
          {inline(m[1])}
        </strong>,
      );
    else if (m[2] !== undefined)
      out.push(
        <code
          key={key}
          className="font-mono text-[0.85em] px-1 bg-zinc-100 dark:bg-line text-phosphor-dim break-words"
        >
          {m[2]}
        </code>,
      );
    else if (m[3] !== undefined)
      out.push(
        /^https?:\/\//.test(m[4]!) ? (
          <a
            key={key}
            href={m[4]}
            className="underline decoration-phosphor-dim underline-offset-2"
            target="_blank"
            rel="noreferrer"
          >
            {inline(m[3])}
          </a>
        ) : (
          inline(m[3])
        ),
      );
    else
      out.push(
        <em key={key} className="text-zinc-600 dark:text-zinc-400">
          {inline(m[5]!)}
        </em>,
      );
    last = re.lastIndex;
    m = re.exec(text);
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function status(r: Release): string {
  if (r.version === "Unreleased") return "next";
  return r.version === current ? "current" : "stable";
}

function ReleaseBody({ r }: { r: Release }) {
  return (
    <div className="mt-5 space-y-5">
      {r.groups
        .filter((g) => g.items.length > 0)
        .map((g, gi) => (
          <div key={`${g.title}-${gi}`} className="panel p-5">
            <div className="font-mono text-xs uppercase tracking-widest text-phosphor-dim mb-3">
              {g.title}
            </div>
            <ul className="space-y-3">
              {g.items.map((it, ii) => (
                <li
                  key={ii}
                  className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300 flex gap-2 min-w-0"
                >
                  <span className="text-phosphor-dim shrink-0">+</span>
                  <span className="min-w-0 break-words">{inline(it)}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
    </div>
  );
}

function ReleaseHeader({ r }: { r: Release }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <h2 id={`v${r.version}`} className="text-2xl font-bold font-mono">
          {r.version === "Unreleased" ? "Unreleased" : `v${r.version}`}
        </h2>
        <span className={`tag ${status(r) === "current" ? "tag-accent" : ""}`}>{status(r)}</span>
        {r.date && <span className="font-mono text-xs text-zinc-500">{r.date}</span>}
      </div>
      {r.tagline && (
        <p className="mt-2 text-zinc-600 dark:text-zinc-400 leading-relaxed">{inline(r.tagline)}</p>
      )}
    </>
  );
}

export function Changelog() {
  return (
    <>
      <section className="grid-bg border-b-2 border-edge dark:border-line">
        <div className="mx-auto max-w-4xl px-4 py-16">
          <div className="tag mb-3">git log --oneline</div>
          <h1 className="text-4xl md:text-6xl font-bold tracking-tight">Changelog</h1>
          <p className="mt-4 text-zinc-600 dark:text-zinc-400">
            {shipped.length} releases, generated from the repository's{" "}
            <code className="font-mono text-sm">CHANGELOG.md</code>
            {current && (
              <>
                {" · latest "}
                <span className="font-mono">v{current}</span>
              </>
            )}
          </p>
        </div>
      </section>
      <section className="mx-auto max-w-4xl px-4 py-14">
        {releases.map((r, ri) => (
          <div
            key={r.version}
            className="relative border-l-2 border-edge dark:border-line pl-6 sm:pl-8 pb-14 min-w-0"
          >
            <span
              className={`absolute -left-[9px] top-1.5 w-4 h-4 border-2 border-ink dark:border-phosphor ${
                r.version === current
                  ? "bg-phosphor dark:bg-phosphor animate-pulse"
                  : "bg-white dark:bg-panel"
              }`}
            />
            {ri < EXPANDED ? (
              <>
                <ReleaseHeader r={r} />
                <ReleaseBody r={r} />
              </>
            ) : (
              <details className="group">
                <summary className="list-none cursor-pointer [&::-webkit-details-marker]:hidden">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <ReleaseHeader r={r} />
                    </div>
                    <ChevronDown
                      size={18}
                      className="mt-2 shrink-0 text-zinc-500 group-open:rotate-180 transition-transform"
                    />
                  </div>
                </summary>
                <ReleaseBody r={r} />
              </details>
            )}
          </div>
        ))}
      </section>
    </>
  );
}
