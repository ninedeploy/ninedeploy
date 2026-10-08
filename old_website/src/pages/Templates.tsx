import { useMemo, useState } from "react";
import { ExternalLink, Search, ShieldCheck, Boxes, Layers } from "lucide-react";
import {
  hubCategories,
  hubTemplates,
  hubUpdated,
  certifiedCount,
  templateCount,
  type HubTemplate,
} from "../hub";
import { Logo } from "../components/Logo";

function TemplateCard({ template }: { template: HubTemplate }) {
  return (
    <article className="group relative flex flex-col border-2 border-edge dark:border-line bg-[var(--nd-panel)] p-4 transition-all hover:-translate-y-0.5 hover:border-ink dark:hover:border-phosphor-dim hover:shadow-[6px_6px_0_0_var(--nd-shadow)]">
      <div className="flex items-start justify-between gap-2">
        <Logo className="w-9 h-9 shrink-0" />
        {/*
          Per-template emoji icons (registry `emoji` field) are intentionally
          not rendered — free-form emoji can read as off-brand or worse, and
          the NineDeploy brand mark is the right icon for "this is a template
          in the NineDeploy hub". The registry field stays in the bundle so
          the data shape is preserved for future per-template brand work.
        */}
        <div className="flex items-center gap-1.5">
          {template.featured && <span className="tag">featured</span>}
          {template.runtimeVerified ? (
            <span
              className="inline-flex items-center gap-1 font-mono text-[10px] font-bold uppercase tracking-wide text-emerald-700 dark:text-emerald-400 border border-emerald-600/40 dark:border-emerald-400/40 px-1.5 py-0.5"
              title={`Passed an isolated container startup and port smoke test${template.verifiedAt ? ` · ${template.verifiedAt}` : ""}`}
            >
              <ShieldCheck size={11} /> certified
            </span>
          ) : null}
        </div>
      </div>

      <h3 className="mt-2.5 font-bold leading-tight">{template.name}</h3>
      <p className="mt-1 text-[13px] text-zinc-600 dark:text-zinc-400 leading-relaxed line-clamp-2">
        {template.tagline}
      </p>

      {template.requires && (
        <p className="mt-2 font-mono text-[10px] text-amber-700 dark:text-amber-400/90 leading-snug line-clamp-2">
          ⚠ {template.requires}
        </p>
      )}

      <div className="mt-auto pt-3">
        <div className="flex items-center justify-between gap-2 font-mono text-[11px] text-zinc-500 dark:text-zinc-500">
          <code className="truncate" title={`${template.image} · port ${template.port}`}>
            {template.image.split("/").at(-1)}
          </code>
          <span className="shrink-0">:{template.port}</span>
        </div>
        <div className="mt-2 flex items-center justify-between gap-2 border-t border-[#dbe4ee] dark:border-line/60 pt-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-500 dark:text-zinc-500">
            {template.category}
          </span>
          <span className="flex items-center gap-2.5">
            {template.website && (
              <a
                href={template.website}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-[10px] font-bold inline-flex items-center gap-1 hover:text-phosphor-dim transition-colors"
                aria-label={`${template.name} website`}
              >
                site <ExternalLink size={10} />
              </a>
            )}
            {template.docs && (
              <a
                href={template.docs}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-[10px] font-bold inline-flex items-center gap-1 hover:text-phosphor-dim transition-colors"
                aria-label={`${template.name} documentation`}
              >
                docs <ExternalLink size={10} />
              </a>
            )}
          </span>
        </div>
      </div>
    </article>
  );
}

export function Templates() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [certifiedOnly, setCertifiedOnly] = useState(false);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return hubTemplates.filter((t) => {
      if (category && t.category !== category) return false;
      if (certifiedOnly && !t.runtimeVerified) return false;
      if (!q) return true;
      return (
        t.name.toLowerCase().includes(q) ||
        t.tagline.toLowerCase().includes(q) ||
        t.category.toLowerCase().includes(q) ||
        t.id.toLowerCase().includes(q)
      );
    });
  }, [query, category, certifiedOnly]);

  return (
    <>
      <section className="grid-bg border-b-2 border-edge dark:border-line">
        <div className="mx-auto max-w-7xl px-4 py-16">
          <div className="tag mb-3">template hub</div>
          <h1 className="text-4xl md:text-6xl font-bold tracking-tight">One click, running.</h1>
          <p className="mt-4 max-w-2xl text-zinc-600 dark:text-zinc-400 leading-relaxed">
            The same catalog your panel ships — pick a template in{" "}
            <strong>Templates → Deploy</strong> and NineDeploy provisions the container, wires the
            network and flips Traefik when the healthcheck passes.{" "}
            {certifiedCount} of {templateCount} carry a runtime certification: an isolated container
            startup plus a declared-port smoke test.
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-2 font-mono text-xs text-zinc-500 dark:text-zinc-500">
            <span className="inline-flex items-center gap-1.5 border border-edge dark:border-line px-2 py-1">
              <Boxes size={12} className="text-phosphor-dim" /> {templateCount} templates
            </span>
            <span className="inline-flex items-center gap-1.5 border border-edge dark:border-line px-2 py-1">
              <Layers size={12} className="text-phosphor-dim" /> {hubCategories.length} categories
            </span>
            {hubUpdated && (
              <span className="inline-flex items-center gap-1.5 border border-edge dark:border-line px-2 py-1">
                registry updated {hubUpdated}
              </span>
            )}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-12">
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <label className="relative flex-1 min-w-56 max-w-md">
              <Search
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400"
                aria-hidden="true"
              />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="search n8n, gitea, umami…"
                aria-label="Search templates"
                className="w-full border-2 border-edge dark:border-line bg-[var(--nd-panel)] py-2 pl-9 pr-3 font-mono text-sm outline-none focus:border-ink dark:focus:border-phosphor-dim"
              />
            </label>
            <button
              type="button"
              onClick={() => setCertifiedOnly((v) => !v)}
              aria-pressed={certifiedOnly}
              className={`inline-flex items-center gap-1.5 border-2 px-3 py-2 font-mono text-xs font-bold transition-colors ${
                certifiedOnly
                  ? "border-ink bg-ink text-white dark:border-phosphor dark:bg-phosphor dark:text-void"
                  : "border-edge dark:border-line hover:border-ink dark:hover:border-phosphor-dim"
              }`}
            >
              <ShieldCheck size={13} /> certified only
            </button>
            <span className="ml-auto font-mono text-xs text-zinc-500 dark:text-zinc-500">
              {visible.length}/{templateCount}
            </span>
          </div>

          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setCategory(null)}
              aria-pressed={category === null}
              className={`border px-2.5 py-1 font-mono text-xs transition-colors ${
                category === null
                  ? "border-ink bg-ink text-white dark:border-phosphor dark:bg-phosphor dark:text-void"
                  : "border-edge dark:border-line hover:border-ink dark:hover:border-phosphor-dim"
              }`}
            >
              all <span className="opacity-60">{templateCount}</span>
            </button>
            {hubCategories.map((cat) => (
              <button
                key={cat.name}
                type="button"
                onClick={() => setCategory((c) => (c === cat.name ? null : cat.name))}
                aria-pressed={category === cat.name}
                className={`border px-2.5 py-1 font-mono text-xs transition-colors ${
                  category === cat.name
                    ? "border-ink bg-ink text-white dark:border-phosphor dark:bg-phosphor dark:text-void"
                    : "border-edge dark:border-line hover:border-ink dark:hover:border-phosphor-dim"
                }`}
              >
                {cat.name.toLowerCase()} <span className="opacity-60">{cat.count}</span>
              </button>
            ))}
          </div>
        </div>

        {visible.length > 0 ? (
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {visible.map((t) => (
              <TemplateCard key={t.id} template={t} />
            ))}
          </div>
        ) : (
          <p className="mt-16 text-center font-mono text-sm text-zinc-500 dark:text-zinc-500">
            no template matches “{query}” — exit 1
          </p>
        )}

        <div className="mt-14 panel panel-hard p-6 font-mono text-sm">
          <div className="font-bold text-base font-sans">Not a marketplace. A registry.</div>
          <p className="mt-2 text-zinc-600 dark:text-zinc-400 leading-relaxed max-w-3xl">
            Everything above ships inside the panel — no account, no telemetry, no phone-home. Run
            your own catalog by pointing the hub at any registry bundle:
          </p>
          <pre className="mt-3 overflow-x-auto border border-edge dark:border-line bg-ink/5 dark:bg-line/30 p-3 text-xs leading-relaxed">
            <code>{`# Settings → System, or the environment:
NINEDEPLOY_TEMPLATES_SOURCE=https://example.com/registry.json`}</code>
          </pre>
        </div>
      </section>
    </>
  );
}
