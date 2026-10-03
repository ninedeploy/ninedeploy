import { NavLink, Outlet, Link } from "react-router";
import { useEffect, useMemo, useState } from "react";
import { BookOpen, Info, TriangleAlert, ArrowRight, Search, X } from "lucide-react";
import { docs, docGroups, type Doc, type Block } from "../docs";
import { CodeBlock } from "../components/CodeBlock";

export { docs as docPages };

export function DocsLayout() {
  const [query, setQuery] = useState("");
  const [progress, setProgress] = useState(0);

  // reading progress under the header
  useEffect(() => {
    const onScroll = () => {
      const h = document.documentElement;
      const max = h.scrollHeight - h.clientHeight;
      setProgress(max > 0 ? h.scrollTop / max : 0);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const q = query.trim().toLowerCase();
  const match = (d: Doc) =>
    !q || d.title.toLowerCase().includes(q) || d.description.toLowerCase().includes(q);
  const visibleGroups = docGroups
    .map((g) => ({ ...g, items: g.items.filter(match) }))
    .filter((g) => g.items.length > 0);

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 lg:grid lg:grid-cols-[240px_1fr] gap-10">
      {/* reading progress */}
      <div className="fixed top-16 left-0 right-0 h-0.5 z-40 bg-transparent pointer-events-none">
        <div
          className="h-full bg-phosphor transition-[width] duration-100"
          style={{ width: `${progress * 100}%` }}
        />
      </div>

      <aside className="hidden lg:block">
        <div className="sticky top-24 thin-scroll max-h-[calc(100vh-8rem)] overflow-y-auto pr-2">
          <div className="flex items-center gap-2 font-mono text-xs uppercase tracking-widest text-zinc-500 mb-3">
            <BookOpen size={13} /> docs
          </div>

          {/* search */}
          <div className="relative mb-4">
            <Search
              size={13}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none"
            />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="filter pages…"
              className="w-full border-2 border-edge dark:border-line bg-transparent font-mono text-xs pl-7 pr-7 py-1.5 outline-none placeholder:text-zinc-400 focus:border-phosphor-dim"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-ink dark:hover:text-phosphor"
                aria-label="Clear filter"
              >
                <X size={12} />
              </button>
            )}
          </div>

          {visibleGroups.length === 0 && (
            <p className="font-mono text-xs text-zinc-500">no pages match “{query}”</p>
          )}

          {visibleGroups.map((g) => (
            <div key={g.name} className="mb-5">
              <div className="font-mono text-[11px] uppercase tracking-widest text-zinc-400 dark:text-zinc-600 mb-1.5">
                {g.name}
              </div>
              <nav className="flex flex-col border-l-2 border-[#dbe4ee] dark:border-line">
                {g.items.map((d) => (
                  <NavLink
                    key={d.slug}
                    to={`/docs/${d.slug}`}
                    className={({ isActive }) =>
                      `pl-3 py-1.5 text-sm font-mono -ml-[2px] border-l-2 transition-colors ${
                        isActive
                          ? "border-ink dark:border-phosphor font-bold"
                          : "border-transparent text-[#4a5c73] dark:text-zinc-400 hover:text-ink dark:hover:text-phosphor"
                      }`
                    }
                  >
                    {d.title}
                  </NavLink>
                ))}
              </nav>
            </div>
          ))}
        </div>
      </aside>

      {/* mobile doc picker */}
      <div className="lg:hidden mb-8 flex gap-2 overflow-x-auto pb-2 thin-scroll">
        {docs.map((d) => (
          <NavLink
            key={d.slug}
            to={`/docs/${d.slug}`}
            className={({ isActive }) =>
              `whitespace-nowrap font-mono text-xs border-2 px-3 py-1.5 ${
                isActive
                  ? "border-ink bg-ink text-white dark:border-phosphor dark:bg-phosphor dark:text-void"
                  : "border-edge dark:border-line"
              }`
            }
          >
            {d.title}
          </NavLink>
        ))}
      </div>

      <div className="min-w-0">
        <Outlet />
      </div>
    </div>
  );
}

export function DocPage({ doc }: { doc: Doc }) {
  const idx = docs.findIndex((d) => d.slug === doc.slug);
  const prev = docs[idx - 1];
  const next = docs[idx + 1];
  const headings = useMemo(
    () => doc.blocks.filter((b) => b.kind === "h2").map((b) => b.text),
    [doc],
  );
  const [active, setActive] = useState<string | null>(null);

  // highlight the TOC entry of the section currently in view
  useEffect(() => {
    const els = headings
      .map((h) => document.getElementById(slugify(h)))
      .filter((el): el is HTMLElement => el !== null);
    if (els.length === 0) return;
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]?.target.id) setActive(visible[0].target.id);
      },
      { rootMargin: "-80px 0px -70% 0px" },
    );
    for (const el of els) io.observe(el);
    return () => io.disconnect();
  }, [headings]);

  return (
    <article className="max-w-3xl xl:max-w-none xl:grid xl:grid-cols-[minmax(0,1fr)_180px] xl:gap-10">
      <div className="min-w-0 max-w-3xl">
      <div className="tag mb-3">{doc.group}</div>
      <h1 className="text-3xl md:text-5xl font-bold tracking-tight">{doc.title}</h1>
      <p className="mt-3 text-zinc-500 dark:text-zinc-400 font-mono text-sm">{doc.description}</p>
      <div className="mt-8 space-y-4">
        {doc.blocks.map((b) => (
          <BlockView key={blockKey(b)} block={b} />
        ))}
      </div>

      <nav className="mt-14 grid grid-cols-2 gap-4 border-t-2 border-edge dark:border-line pt-6">
        {prev ? (
          <Link to={`/docs/${prev.slug}`} className="font-mono text-sm group">
            <span className="text-zinc-500 text-xs uppercase tracking-widest">← prev</span>
            <div className="link-underline font-bold">{prev.title}</div>
          </Link>
        ) : (
          <span />
        )}
        {next && (
          <Link to={`/docs/${next.slug}`} className="font-mono text-sm text-right group">
            <span className="text-zinc-500 text-xs uppercase tracking-widest">next →</span>
            <div className="link-underline font-bold flex items-center justify-end gap-1">
              {next.title} <ArrowRight size={13} />
            </div>
          </Link>
        )}
      </nav>
      </div>

      {headings.length > 0 && (
        <aside className="hidden xl:block">
          <div className="sticky top-24">
            <div className="font-mono text-[11px] uppercase tracking-widest text-zinc-400 dark:text-zinc-600 mb-2">
              on this page
            </div>
            <nav className="flex flex-col border-l-2 border-[#dbe4ee] dark:border-line">
              {headings.map((h) => {
                const id = slugify(h);
                const isActive = active === id;
                return (
                  <a
                    key={h}
                    href={`#${id}`}
                    className={`pl-3 py-1 -ml-[2px] border-l-2 text-sm font-mono transition-colors ${
                      isActive
                        ? "border-phosphor-dim text-phosphor-dim font-bold"
                        : "border-transparent text-[#4a5c73] dark:text-zinc-400 hover:text-ink hover:border-ink dark:hover:text-phosphor dark:hover:border-phosphor"
                    }`}
                  >
                    {h}
                  </a>
                );
              })}
            </nav>
          </div>
        </aside>
      )}
    </article>
  );
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function blockKey(b: Block): string {
  return `${b.kind}:${"text" in b && b.text ? b.text : "code"}`;
}

function BlockView({ block: b }: { block: Block }) {
  switch (b.kind) {
    case "h2":
      return (
        <h2 id={slugify(b.text)} className="pt-6 text-2xl font-bold tracking-tight flex items-center gap-3">
          <span className="w-2 h-2 bg-phosphor-dim" />
          {b.text}
        </h2>
      );
    case "h3":
      return <h3 id={slugify(b.text)} className="pt-2 text-lg font-bold">{b.text}</h3>;
    case "p":
      return <p className="text-zinc-700 dark:text-zinc-300 leading-relaxed">{b.text}</p>;
    case "list":
      return (
        <ul className="space-y-2">
          {b.items.map((it) => (
            <li key={it} className="flex gap-3 text-zinc-700 dark:text-zinc-300 leading-relaxed">
              {it}
            </li>
          ))}
        </ul>
      );
    case "code":
      return <CodeBlock file={b.file}>{b.body}</CodeBlock>;
    case "callout":
      return (
        <div
          className={`panel px-5 py-4 my-6 flex gap-3 ${
            b.tone === "warn" ? "border-amber-term" : ""
          }`}
        >
          {b.tone === "warn" ? (
            <TriangleAlert size={18} className="text-amber-term shrink-0 mt-0.5" />
          ) : (
            <Info size={18} className="text-cyan-term shrink-0 mt-0.5" />
          )}
          <div>
            <div className="font-bold text-sm">{b.title}</div>
            <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1 leading-relaxed">{b.text}</p>
          </div>
        </div>
      );
  }
}
