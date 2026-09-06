import { Link } from "react-router";
import { useState } from "react";
import {
  ArrowRight,
  Boxes,
  Check,
  Copy,
  Database,
  GitBranch,
  Globe,
  KeyRound,
  LayoutGrid,
  Network,
  Rocket,
  RotateCcw,
  Server,
  ShieldCheck,
  Timer,
  Waypoints,
} from "lucide-react";
import { Terminal, type TermLine } from "../components/Terminal";
import { Marquee } from "../components/Marquee";
import { CountUp } from "../components/CountUp";
import { Reveal } from "../components/Reveal";
import { certifiedCount, templateCount, templateNames } from "../hub";

const heroLines: TermLine[] = [
  { text: "$ git push origin main", tone: "dim", ts: "12:01:02" },
  { text: "→ webhook verified (hmac-sha256) · branch=main · paths=[src/**]", tone: "accent", ts: "12:01:02" },
  { text: "→ deployment #47 queued", tone: "dim", ts: "12:01:03" },
  { text: "→ worker slot-1 claimed · building", tone: "warn", ts: "12:01:04" },
  { text: "→ clone ok · checkout 9f3c1ab · creds scrubbed", tone: "dim", ts: "12:01:09" },
  { text: "→ docker build ✓  · image nd-svc-api:9f3c1ab", tone: "ok", ts: "12:02:41" },
  { text: "→ blue-green: new container up on net ninedeploy", tone: "dim", ts: "12:02:44" },
  { text: "→ healthcheck 200 OK (container ip, 3/3)", tone: "ok", ts: "12:02:52" },
  { text: "→ traefik router flipped · old container retired", tone: "ok", ts: "12:02:52" },
  { text: "✓ live at https://api.acme.dev — 0s downtime", tone: "ok", ts: "12:02:53" },
];

const templates = templateNames.slice(0, 18);

const bento = [
  {
    icon: Timer,
    title: "Blue-green, zero downtime",
    body: "The new container is healthchecked before the old one retires. Failure? The previous version keeps serving — automatic rollback to the exact commit or pinned image digest.",
    tag: "deploys",
  },
  {
    icon: Database,
    title: "Managed databases",
    body: "PostgreSQL, MySQL, MariaDB, Redis, Valkey, MongoDB, ClickHouse, Meilisearch and RabbitMQ — one click, encrypted credentials, connection strings auto-injected into attached services.",
    tag: "data",
  },
  {
    icon: Globe,
    title: "Wildcard HTTPS",
    body: "Traefik ingress with ACME DNS-01. One *.your-domain cert up front; {slug}.your-domain auto-assigned to every service.",
    tag: "network",
  },
  {
    icon: Network,
    title: "Multi-server agents",
    body: "Register remote hosts running the agent. Typed operations only — docker pull/build/run, git checkout — never raw shell over the wire.",
    tag: "fleet",
  },
  {
    icon: ShieldCheck,
    title: "Security-first core",
    body: "Argon2id, TOTP 2FA, AES-256-GCM secrets with key rotation, RBAC, audit log, brute-force lockout, rate limiting — all built in.",
    tag: "security",
  },
  {
    icon: Waypoints,
    title: "Everything observable",
    body: "Live CPU/mem per container, alert rules with sustained-breach windows, topology graph, WebSocket deploy logs, exec terminal.",
    tag: "ops",
  },
];

const compare: Array<{
  label: string;
  us: string;
  rawDocker: string;
  managedPaaS: string;
}> = [
  { label: "your data stays on your server", us: "✓ always", rawDocker: "✓ yes", managedPaaS: "✗ vendor cloud" },
  { label: "zero-downtime deploys out of the box", us: "✓ blue-green", rawDocker: "✗ DIY scripts", managedPaaS: "✓ yes" },
  { label: "managed databases + backups", us: "✓ 9 engines, S3", rawDocker: "✗ manual", managedPaaS: "✓ metered" },
  { label: "automatic HTTPS + wildcard domains", us: "✓ ACME DNS-01", rawDocker: "✗ manual proxy", managedPaaS: "✓ yes" },
  { label: "price at 50 services", us: "$0 · your hardware", rawDocker: "$0 · your weekends", managedPaaS: "$$$ per seat" },
  { label: "lock-in", us: "✗ none · MIT", rawDocker: "✗ none", managedPaaS: "✓ proprietary" },
];

const steps = [
  {
    icon: Server,
    n: "01",
    title: "Install on your server",
    body: "One curl against install.sh. Node ≥ 22.13 + Docker is all it takes — the core runs under a hardened systemd unit with verified HTTP readiness.",
  },
  {
    icon: GitBranch,
    n: "02",
    title: "Connect a repo or image",
    body: `Git (PAT or SSH deploy key), a container image, a Compose stack, or one of ${templateCount} hub templates (${certifiedCount} runtime-certified). Watch-path globs keep monorepos quiet.`,
  },
  {
    icon: Rocket,
    n: "03",
    title: "Ship, watch, roll back",
    body: "Push to deploy. Stream the build live over WebSocket. One-click rollback pins the exact digest. Cancel mid-flight any time.",
  },
];

export function Home() {
  return (
    <>
      {/* ---------------- hero ---------------- */}
      <section className="grid-bg relative">
        <div className="mx-auto max-w-7xl px-4 pt-16 pb-20 md:pt-24 md:pb-28 grid lg:grid-cols-2 gap-12 items-center">
          <div>
            <div className="flex flex-wrap gap-2 mb-6">
              <span className="tag tag-accent">
                self-hosted PaaS
              </span>
              <span className="tag font-bold">v0.7.2</span>
              <span className="tag">6,460 tests in CI</span>
            </div>
            <h1 className="text-5xl md:text-7xl font-bold leading-[0.95] tracking-tight">
              Ship like you
              <br />
              <span className="text-phosphor-dim">mean it.</span>
              <span className="inline-block w-4 h-10 md:h-14 ml-2 -mb-1 bg-ink dark:bg-phosphor animate-blink" />
            </h1>
            <p className="mt-6 max-w-lg text-lg text-zinc-600 dark:text-zinc-400 leading-relaxed">
              NineDeploy wraps Docker, PM2 and Traefik behind one dashboard, one
              CLI and one MCP server. Zero-downtime deploys, managed databases,
              encrypted secrets — on{" "}
              <span className="font-mono text-base">your</span> hardware, in a
              single SQLite file.
            </p>
            <div className="mt-8 flex flex-wrap gap-4 items-center">
              <Link
                to="/docs/installation"
                className="font-mono font-bold border-2 border-ink bg-ink text-white dark:border-phosphor dark:bg-phosphor dark:text-void px-6 py-3 hover:-translate-y-0.5 transition-transform"
              >
                curl the installer <ArrowRight size={15} className="inline ml-1 -mt-0.5" />
              </Link>
              <Link
                to="/docs/introduction"
                className="font-mono border-2 border-edge dark:border-line px-6 py-3 hover:bg-ink hover:text-white dark:hover:bg-line dark:hover:text-phosphor transition-colors"
              >
                read the docs
              </Link>
            </div>
            <div className="mt-8 flex flex-wrap gap-x-6 gap-y-2 font-mono text-xs text-zinc-500">
              <span>✦ no vendor lock-in</span>
              <span>✦ no external DB</span>
              <span>✦ MIT licensed</span>
            </div>
          </div>
          <div className="relative">
            <div
              aria-hidden="true"
              className="absolute -inset-8 -z-10 rounded-full opacity-60 blur-3xl"
              style={{
                background:
                  "radial-gradient(closest-side, rgb(78 205 196 / 0.25), transparent)",
              }}
            />
            <Terminal lines={heroLines} />
          </div>
        </div>
      </section>

      <Marquee items={templates} />

      {/* ---------------- bento ---------------- */}
      <section className="mx-auto max-w-7xl px-4 py-20 md:py-28">
        <div className="mb-12 flex items-end justify-between gap-6 flex-wrap">
          <div>
            <div className="tag mb-3">what you get</div>
            <h2 className="text-3xl md:text-5xl font-bold tracking-tight">
              A platform, not a puzzle.
            </h2>
          </div>
          <Link to="/features" className="link-underline font-mono text-sm">
            all features →
          </Link>
        </div>
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5">
          {bento.map((b, i) => (
            <Reveal key={b.title} delay={i * 70} className="h-full">
              <article className="panel panel-hard h-full p-6 hover:-translate-y-1 transition-transform group relative overflow-hidden">
                {/* hover glow — brand teal wash in the corner */}
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute -right-10 -top-10 h-28 w-28 rounded-full opacity-0 blur-2xl transition-opacity duration-500 group-hover:opacity-100"
                  style={{ background: "rgb(78 205 196 / 0.22)" }}
                />
                <div className="flex items-start justify-between">
                  <b.icon
                    size={26}
                    className="text-ink dark:text-phosphor transition-transform duration-300 group-hover:scale-110 group-hover:-rotate-6"
                    strokeWidth={1.75}
                  />
                  <span className="tag text-zinc-500">{b.tag}</span>
                </div>
                <h3 className="mt-4 text-lg font-bold">{b.title}</h3>
                <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400 leading-relaxed">
                  {b.body}
                </p>
              </article>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ---------------- comparison ---------------- */}
      <section className="border-y-2 border-edge dark:border-line bg-[var(--nd-panel)]">
        <div className="mx-auto max-w-7xl px-4 py-20 md:py-24">
          <Reveal>
            <div className="tag mb-3">the honest pitch</div>
            <h2 className="text-3xl md:text-5xl font-bold tracking-tight">
              Raw Docker, a managed PaaS, or NineDeploy?
            </h2>
          </Reveal>
          <Reveal delay={120}>
            <div className="panel panel-hard mt-10 overflow-x-auto">
              <table className="w-full min-w-[40rem] border-collapse font-mono text-sm">
                <thead>
                  <tr className="border-b-2 border-edge dark:border-line text-left">
                    <th className="p-4 font-sans font-bold"> </th>
                    <th className="p-4 bg-ink text-white dark:bg-line dark:text-phosphor font-bold">
                      NineDeploy
                    </th>
                    <th className="p-4 font-bold text-zinc-500">raw docker</th>
                    <th className="p-4 font-bold text-zinc-500">managed PaaS</th>
                  </tr>
                </thead>
                <tbody>
                  {compare.map((row) => (
                    <tr key={row.label} className="border-b border-[#dbe4ee] dark:border-line/60 last:border-0">
                      <td className="p-4 font-sans">{row.label}</td>
                      <td className="p-4 bg-ink/5 dark:bg-line/30">
                        <span className="inline-flex items-center gap-1.5 font-bold text-phosphor-dim">
                          <Check size={14} className="-mt-0.5" /> {row.us}
                        </span>
                      </td>
                      <td className="p-4 text-zinc-500">{row.rawDocker}</td>
                      <td className="p-4 text-zinc-500">{row.managedPaaS}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ---------------- pipeline steps ---------------- */}
      <section className="border-y-2 border-edge dark:border-line bg-ink dark:bg-panel text-zinc-300">
        <div className="mx-auto max-w-7xl px-4 py-20 md:py-28">
          <div className="tag mb-3 border-phosphor text-phosphor">three steps</div>
          <h2 className="text-3xl md:text-5xl font-bold tracking-tight text-white">
            From curl to production.
          </h2>
          <div className="mt-12 grid md:grid-cols-3 gap-8">
            {steps.map((s, i) => (
              <Reveal key={s.n} delay={i * 100} className="relative border-l-2 border-line pl-6">
                <span className="absolute -left-[13px] top-0 grid place-items-center w-6 h-6 border-2 border-phosphor bg-ink font-mono text-[10px] text-phosphor">
                  {s.n.slice(1)}
                </span>
                <s.icon size={24} className="text-phosphor" strokeWidth={1.75} />
                <h3 className="mt-3 text-lg font-bold text-white">{s.title}</h3>
                <p className="mt-2 text-sm text-zinc-400 leading-relaxed">{s.body}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------- stats ---------------- */}
      <section className="mx-auto max-w-7xl px-4 py-16 grid grid-cols-2 md:grid-cols-4 gap-5">
        {[
          { icon: LayoutGrid, k: certifiedCount, suffix: "", v: "runtime-certified templates" },
          { icon: Boxes, k: 41, suffix: "", v: "tables, one SQLite file" },
          { icon: RotateCcw, k: 6460, suffix: "", v: "tests in CI" },
          { icon: KeyRound, k: 95, suffix: "%+", v: "enforced coverage floor" },
        ].map((s, i) => (
          <Reveal key={s.v} delay={i * 60}>
            <div className="panel p-5 text-center hover:-translate-y-1 transition-transform">
              <s.icon size={20} className="mx-auto text-phosphor-dim" />
              <div className="mt-2 text-3xl font-bold font-mono">
                <CountUp value={s.k} suffix={s.suffix} />
              </div>
              <div className="text-xs font-mono uppercase tracking-widest text-zinc-500 mt-1">
                {s.v}
              </div>
            </div>
          </Reveal>
        ))}
      </section>

      {/* ---------------- CTA ---------------- */}
      <section className="grid-bg border-t-2 border-edge dark:border-line">
        <div className="mx-auto max-w-4xl px-4 py-20 text-center">
          <h2 className="text-3xl md:text-5xl font-bold tracking-tight">
            Your server. Your rules.
          </h2>
          <p className="mt-4 text-zinc-600 dark:text-zinc-400">
            One command, one admin account, one dashboard. Deploys in minutes.
          </p>
          <CodeBlockImpl />
        </div>
      </section>
    </>
  );
}

function CodeBlockImpl() {
  const [copied, setCopied] = useState(false);
  const cmd =
    "curl -fsSL https://raw.githubusercontent.com/NineDeploy/NineDeploy/main/install.sh | bash";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard denied — the text is selectable anyway */
    }
  };
  return (
    <div className="panel panel-hard mx-auto mt-8 max-w-2xl text-left overflow-x-auto px-5 py-4 font-mono text-sm">
      <div className="flex items-center justify-between gap-4">
        <span className="text-zinc-500">$</span>
        <button
          type="button"
          onClick={copy}
          className="flex items-center gap-1.5 border border-edge dark:border-line px-2 py-0.5 text-xs text-zinc-500 hover:text-phosphor-dim hover:border-phosphor-dim transition-colors"
          aria-label="Copy install command"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? "copied ✓" : "copy"}
        </button>
      </div>
      <div>
        <span className="text-phosphor-dim">curl</span> -fsSL https://raw.githubusercontent.com/NineDeploy/NineDeploy/main/install.sh{" "}
        <span className="text-amber-term">|</span> bash
      </div>
    </div>
  );
}
