import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Link, NavLink, useLocation } from "react-router";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Menu,
  X,
  Sun,
  Moon,
  ChevronDown,
  ExternalLink,
  BookOpen,
  Boxes,
  Zap,
  History,
  HelpCircle,
  Terminal as TerminalIcon,
  Sparkles,
  Layers,
  ShieldCheck,
  Cpu,
  ArrowRight,
  Database,
  Radio,
  Server,
  KeyRound,
  FileCode,
  Sliders,
  LifeBuoy,
  Tag,
  HardDrive,
  GitBranch,
} from "lucide-react";
import { Logo } from "./Logo";
import { certifiedCount, templateCount } from "../hub";
import { docs } from "../docs";

const quickPicks = [
  {
    title: "1-Click Installation",
    desc: "Get started in 60s via bash installer or Docker",
    slug: "installation",
    badge: "$ curl | bash",
    icon: Zap,
  },
  {
    title: "Model Context Protocol",
    desc: "35 MCP tools for Claude, Cursor, Antigravity",
    slug: "mcp",
    badge: "AI Native",
    icon: Sparkles,
  },
  {
    title: "Terminal CLI",
    desc: "Command-line deploy, logs & secret vaults",
    slug: "cli",
    badge: "npx ninedeploy",
    icon: TerminalIcon,
  },
];

const docCategories = [
  {
    title: "Core Platform",
    icon: Layers,
    items: [
      { slug: "deploy-pipeline", title: "Deploy Pipeline", desc: "Blue-green, rollbacks & webhooks", icon: RocketIcon },
      { slug: "databases", title: "Managed Databases", desc: "Postgres, Redis, Mongo, ClickHouse", icon: Database },
      { slug: "workspaces-rbac", title: "Workspaces & RBAC", desc: "Multi-tenant teams & permissions", icon: ShieldCheck },
      { slug: "ingress-traefik-tunnels", title: "Ingress & SSL", desc: "Traefik & Cloudflare Tunnels", icon: Radio },
      { slug: "alerts-notifications", title: "Alerts & Webhooks", desc: "Telegram, Discord, Slack, SMTP", icon: Zap },
      { slug: "multi-server", title: "Multi-Server Clusters", desc: "SSH auto-provisioning & agents", icon: Server },
      { slug: "tags-projects-labels", title: "Projects & Tags", desc: "Workspaces, projects & labels", icon: Tag },
      { slug: "volumes-storage", title: "Volumes & Storage", desc: "Attachments, snapshots & restore", icon: HardDrive },
      { slug: "ninedeploy-manifest", title: ".ninedeploy Manifest", desc: "Config committed next to the code", icon: FileCode },
      { slug: "private-repos", title: "Private Repos & Sources", desc: "Deploy keys & auto-deploy webhooks", icon: GitBranch },
    ],
  },
  {
    title: "Interfaces & Security",
    icon: TerminalIcon,
    items: [
      { slug: "api", title: "REST API & SDK", desc: "Full typed TypeScript client", icon: FileCode },
      { slug: "security-sso", title: "Security & OIDC SSO", desc: "WebAuthn passkeys & OAuth2", icon: KeyRound },
      { slug: "configuration", title: "Configuration Flags", desc: "Environment variables reference", icon: Sliders },
      { slug: "troubleshooting", title: "Troubleshooting", desc: "Common errors & fix runbooks", icon: LifeBuoy },
    ],
  },
  {
    title: "Extend & Architecture",
    icon: Cpu,
    items: [
      { slug: "microkernel", title: "Microkernel Engine", desc: "EventBus & waterfall hooks", icon: Cpu },
      { slug: "plugin-sdk", title: "Plugin SDK", desc: "Build & publish custom extensions", icon: Sparkles },
      { slug: "config-center", title: "Configuration Center", desc: "Dual-vault encrypted config store", icon: Sliders },
      { slug: "introduction", title: "System Architecture", desc: "Design principles & SQLite core", icon: BookOpen },
    ],
  },
];

function RocketIcon(props: { size?: number; className?: string }) {
  return <Zap {...props} />;
}

const simpleNav = [
  { to: "/features", label: "Features", icon: Zap },
  { to: "/templates", label: "Templates", icon: Boxes },
  { to: "/changelog", label: "Changelog", icon: History },
  { to: "/faq", label: "FAQ", icon: HelpCircle },
];

export function Layout({
  children,
  theme,
  onToggleTheme,
}: {
  children: ReactNode;
  theme: "dark" | "light";
  onToggleTheme: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  const onDocs = pathname.startsWith("/docs");

  // Scroll state: progress bar fill + a tighter header once the page moves.
  const [progress, setProgress] = useState(0);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const max = document.documentElement.scrollHeight - window.innerHeight;
        setProgress(max > 0 ? window.scrollY / max : 0);
        setScrolled(window.scrollY > 24);
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, []);

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    `px-3 py-1.5 inline-flex items-center gap-1.5 transition-colors ${
      isActive
        ? "bg-ink text-white dark:bg-line dark:text-phosphor"
        : "hover:bg-ink hover:text-white dark:hover:bg-line dark:hover:text-phosphor"
    }`;

  return (
    <div className="min-h-screen flex flex-col">
      <a
        href="#main"
        className="skip-link font-mono text-sm font-bold border-2 border-ink bg-ink text-white dark:border-phosphor dark:bg-phosphor dark:text-void px-4 py-2"
      >
        skip to content →
      </a>
      <header
        className={`sticky top-0 z-50 border-b-2 border-edge dark:border-line bg-[var(--nd-bg)]/90 backdrop-blur transition-shadow ${
          scrolled ? "shadow-[0_4px_24px_-8px_rgb(30_42_58/0.25)] dark:shadow-[0_4px_24px_-8px_rgb(0_0_0/0.6)]" : ""
        }`}
      >
        <div
          aria-hidden="true"
          className="absolute left-0 bottom-[-2px] h-[2px] w-full origin-left bg-phosphor"
          style={{ transform: `scaleX(${progress})` }}
        />
        <div className={`mx-auto max-w-7xl px-4 flex items-center gap-6 transition-all ${scrolled ? "h-14" : "h-16"}`}>
          <Link to="/" className="flex items-center gap-2.5 font-bold tracking-tight text-lg">
            <Logo className="w-9 h-9" />
            <span>
              nine<span className="text-phosphor-dim">deploy</span>
            </span>
          </Link>

          <nav className="hidden md:flex items-center gap-1 ml-4 font-mono text-sm">
            {simpleNav.map((item) => (
              <NavLink key={item.to} to={item.to} className={navLinkClass}>
                <item.icon size={14} /> {item.label}
              </NavLink>
            ))}

            {/* Docs: mega menu — high-clarity 3-column + featured panel */}
            <DropdownMenu.Root>
              <DropdownMenu.Trigger className="group px-3 py-1.5 inline-flex items-center gap-1.5 outline-none transition-colors hover:bg-ink hover:text-white dark:hover:bg-line dark:hover:text-phosphor data-[state=open]:bg-ink data-[state=open]:text-white dark:data-[state=open]:bg-line dark:data-[state=open]:text-phosphor">
                <BookOpen size={14} className={onDocs ? "text-phosphor-dim" : undefined} />{" "}
                <span className={onDocs ? "text-phosphor-dim" : undefined}>Docs</span>{" "}
                <ChevronDown size={13} className="transition-transform group-data-[state=open]:rotate-180" />
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  sideOffset={12}
                  align="start"
                  className="z-50 w-[min(58rem,calc(100vw-2rem))] border-2 border-edge dark:border-line bg-[var(--nd-panel)] shadow-[8px_8px_0_0_var(--nd-shadow)] overflow-hidden animate-in fade-in-50 zoom-in-95 duration-150"
                >
                  <div className="grid lg:grid-cols-[220px_1fr] divide-y lg:divide-y-0 lg:divide-x divide-[#dbe4ee] dark:divide-line">
                    {/* Left: Featured / Quick Picks */}
                    <div className="p-4 bg-[#f4f7fb]/60 dark:bg-[#070b10]/60 flex flex-col justify-between gap-3">
                      <div>
                        <div className="font-mono text-[10px] uppercase font-bold tracking-widest text-[#4a5c73] dark:text-zinc-500 mb-2.5 flex items-center gap-1.5">
                          <Sparkles size={11} className="text-phosphor-dim" /> Quick Start
                        </div>
                        <div className="space-y-1.5">
                          {quickPicks.map((pick) => (
                            <DropdownMenu.Item key={pick.slug} asChild>
                              <Link
                                to={`/docs/${pick.slug}`}
                                className="group block p-2.5 border border-[#dbe4ee] dark:border-line/70 bg-[var(--nd-panel)] hover:border-ink dark:hover:border-phosphor-dim hover:bg-ink/5 dark:hover:bg-line/30 transition-all outline-none"
                              >
                                <div className="flex items-center justify-between gap-1 mb-1">
                                  <span className="font-mono text-xs font-bold group-hover:text-phosphor-dim transition-colors flex items-center gap-1.5">
                                    <pick.icon size={12} /> {pick.title}
                                  </span>
                                </div>
                                <p className="text-[11px] text-[#4a5c73] dark:text-zinc-400 line-clamp-2 leading-relaxed">
                                  {pick.desc}
                                </p>
                                <div className="mt-2 inline-block font-mono text-[10px] font-semibold px-1.5 py-0.5 bg-[#e2ebf4] dark:bg-line text-ink dark:text-phosphor">
                                  {pick.badge}
                                </div>
                              </Link>
                            </DropdownMenu.Item>
                          ))}
                        </div>
                      </div>

                      <div className="pt-2 border-t border-[#dbe4ee] dark:border-line">
                        <DropdownMenu.Item asChild>
                          <Link
                            to="/docs/introduction"
                            className="group flex items-center justify-between text-xs font-mono font-bold text-ink dark:text-phosphor hover:opacity-80 transition-opacity"
                          >
                            <span>Read Introduction</span>
                            <ArrowRight size={13} className="group-hover:translate-x-0.5 transition-transform" />
                          </Link>
                        </DropdownMenu.Item>
                      </div>
                    </div>

                    {/* Right: Categorized Directory Grid */}
                    <div className="p-4 grid sm:grid-cols-3 gap-4">
                      {docCategories.map((cat) => (
                        <div key={cat.title} className="flex flex-col min-w-0">
                          <div className="font-mono text-[11px] uppercase font-bold tracking-wider text-[#4a5c73] dark:text-zinc-400 pb-1.5 mb-1.5 border-b border-[#dbe4ee] dark:border-line flex items-center gap-1.5">
                            <cat.icon size={13} className="text-phosphor-dim" />
                            <span>{cat.title}</span>
                          </div>
                          <div className="flex flex-col space-y-0.5">
                            {cat.items.map((item) => (
                              <DropdownMenu.Item key={item.slug} asChild>
                                <Link
                                  to={`/docs/${item.slug}`}
                                  className="group rounded px-2 py-1.5 outline-none hover:bg-ink hover:text-white dark:hover:bg-line dark:hover:text-phosphor transition-colors block"
                                >
                                  <div className="font-mono text-xs font-bold leading-tight group-hover:text-white dark:group-hover:text-phosphor">
                                    {item.title}
                                  </div>
                                  <div className="text-[11px] text-[#4a5c73] dark:text-zinc-400 group-hover:text-zinc-200 dark:group-hover:text-zinc-300 truncate mt-0.5">
                                    {item.desc}
                                  </div>
                                </Link>
                              </DropdownMenu.Item>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Mega Menu Footer Bar */}
                  <div className="px-4 py-2.5 bg-[#eef3f8] dark:bg-[#06090e] border-t-2 border-edge dark:border-line flex items-center justify-between gap-4 font-mono text-xs">
                    <span className="text-[#4a5c73] dark:text-zinc-400 flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-phosphor-dim animate-pulse" />
                      {docs.length} documentation guides · v0.7.2 GA
                    </span>
                    <DropdownMenu.Item asChild>
                      <Link
                        to="/docs/introduction"
                        className="font-bold border border-ink bg-ink text-white dark:border-phosphor dark:bg-phosphor dark:text-void px-3 py-1 hover:opacity-85 transition-opacity flex items-center gap-1"
                      >
                        All docs <ArrowRight size={11} />
                      </Link>
                    </DropdownMenu.Item>
                  </div>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <a
              href="https://github.com/NineDeploy/NineDeploy"
              target="_blank"
              rel="noreferrer"
              className="hidden sm:grid place-items-center w-9 h-9 border-2 border-edge dark:border-line hover:bg-ink hover:text-white dark:hover:bg-line dark:hover:text-phosphor transition-colors"
              aria-label="GitHub"
            >
              <ExternalLink size={16} />
            </a>
            <button
              type="button"
              onClick={onToggleTheme}
              className="grid place-items-center w-9 h-9 border-2 border-edge dark:border-line hover:bg-ink hover:text-white dark:hover:bg-line dark:hover:text-phosphor transition-colors"
              aria-label="Toggle theme"
            >
              {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            <Link
              to="/docs/installation"
              className="hidden md:inline-block font-mono text-sm font-bold border-2 border-ink bg-ink text-white dark:border-phosphor dark:bg-phosphor dark:text-void px-4 py-1.5 hover:-translate-y-0.5 transition-transform"
            >
              $ install
            </Link>
            <button
              type="button"
              className="md:hidden grid place-items-center w-9 h-9 border-2 border-edge dark:border-line"
              onClick={() => setOpen(!open)}
              aria-label="Menu"
            >
              {open ? <X size={16} /> : <Menu size={16} />}
            </button>
          </div>
        </div>

        {open && (
          <nav className="md:hidden border-t-2 border-edge dark:border-line bg-[var(--nd-panel)] px-4 py-3 flex flex-col gap-1 font-mono text-sm">
            <Link
              to="/docs/introduction"
              onClick={() => setOpen(false)}
              className="px-3 py-2 flex items-center gap-2 hover:bg-ink hover:text-white dark:hover:bg-line dark:hover:text-phosphor"
            >
              <BookOpen size={14} /> Docs
            </Link>
            {simpleNav.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                onClick={() => setOpen(false)}
                className="px-3 py-2 flex items-center gap-2 hover:bg-ink hover:text-white dark:hover:bg-line dark:hover:text-phosphor"
              >
                <item.icon size={14} /> {item.label}
              </Link>
            ))}
            <Link
              to="/docs/installation"
              onClick={() => setOpen(false)}
              className="mt-1 text-center font-bold border-2 border-ink bg-ink text-white dark:border-phosphor dark:bg-phosphor dark:text-void px-4 py-2"
            >
              $ install
            </Link>
          </nav>
        )}
      </header>

      <main id="main" className="flex-1">{children}</main>

      <footer className="border-t-2 border-edge dark:border-line bg-[var(--nd-panel)]">
        <div className="mx-auto max-w-7xl px-4 py-12 grid gap-10 md:grid-cols-4 font-mono text-sm">
          <div className="space-y-3">
            <div className="flex items-center gap-2.5 font-sans font-bold text-base">
              <Logo className="w-7 h-7" />
              nine<span className="text-phosphor-dim -ml-1">deploy</span>
            </div>
            <p className="text-[#4a5c73] dark:text-zinc-400 leading-relaxed">
              Self-hosted deploys with terminal-grade power. Your server, your
              containers, your data.
            </p>
            <div className="tag">MIT license</div>
          </div>
          <div>
            <div className="tag mb-3">product</div>
            <ul className="space-y-2 text-[#4a5c73] dark:text-zinc-400">
              <li><Link className="link-underline" to="/features">Features</Link></li>
              <li><Link className="link-underline" to="/changelog">Changelog</Link></li>
              <li><Link className="link-underline" to="/faq">FAQ</Link></li>
              <li><a className="link-underline" href="https://github.com/NineDeploy/NineDeploy">GitHub</a></li>
            </ul>
          </div>
          <div>
            <div className="tag mb-3">docs</div>
            <ul className="space-y-2 text-[#4a5c73] dark:text-zinc-400">
              <li><Link className="link-underline" to="/docs/installation">Installation</Link></li>
              <li><Link className="link-underline" to="/docs/deploy-pipeline">Deploy pipeline</Link></li>
              <li><Link className="link-underline" to="/docs/api">API</Link></li>
              <li><Link className="link-underline" to="/docs/mcp">MCP server</Link></li>
            </ul>
          </div>
          <div>
            <div className="tag mb-3">status</div>
            <ul className="space-y-2 text-[#4a5c73] dark:text-zinc-400">
              <li className="flex items-center gap-2">
                <span className="w-2 h-2 bg-phosphor-dim animate-pulse" /> v0.7.2 GA
              </li>
              <li>6,460 tests in CI</li>
              <li>SQLite core · Zero external DB</li>
              <li>
                <Link className="link-underline" to="/templates">
                  {templateCount} templates · {certifiedCount} runtime-certified
                </Link>
              </li>
            </ul>
          </div>
        </div>
        <div className="border-t border-[#dbe4ee] dark:border-line/60">
          <div className="mx-auto max-w-7xl px-4 py-8">
            <div className="panel panel-hard flex flex-wrap items-center justify-between gap-4 p-6">
              <div>
                <div className="font-bold text-lg">
                  star the repo, ship your own
                </div>
                <p className="mt-1 font-mono text-sm text-[#4a5c73] dark:text-zinc-400">
                  MIT licensed · self-hosted · no accounts on our side — there is no “our side”.
                </p>
              </div>
              <a
                href="https://github.com/NineDeploy/NineDeploy"
                target="_blank"
                rel="noreferrer"
                className="font-mono font-bold border-2 border-ink bg-ink text-white dark:border-phosphor dark:bg-phosphor dark:text-void px-6 py-3 hover:-translate-y-0.5 transition-transform"
              >
                ★ github /ninedeploy
              </a>
            </div>
          </div>
        </div>
        <div className="border-t border-[#dbe4ee] dark:border-line/60 py-4 text-center font-mono text-xs text-[#4a5c73] dark:text-zinc-500">
          exit 0 — built with an unhealthy love of terminals
        </div>
      </footer>
    </div>
  );
}
