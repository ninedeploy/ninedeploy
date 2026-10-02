import { Link } from "react-router";
import {
  AlarmClockCheck,
  Bell,
  Boxes,
  Building2,
  CalendarClock,
  Container,
  Copy,
  Database,
  FileCode,
  FileStack,
  GitBranch,
  Globe,
  HardDrive,
  KeyRound,
  Lock,
  MonitorSmartphone,
  Network,
  RotateCcw,
  ScrollText,
  Server,
  Shield,
  ShieldCheck,
  FolderTree,
  FolderKanban,
  Tag,
  Layers,
  Mail,
  Terminal as TerminalIcon,
  Waypoints,
} from "lucide-react";
import { certifiedCount, templateCount } from "../hub";

const groups: {
  title: string;
  items: { icon: typeof Boxes; title: string; body: string }[];
}[] = [
  {
    title: "Deploy",
    items: [
      {
        icon: Container,
        title: "Three service types",
        body: "Docker images (built or pulled), PM2-managed Node processes, and Docker Compose stacks with an ndcmp- project prefix — first-class, not bolted on.",
      },
      {
        icon: GitBranch,
        title: "Git, registry, or hub",
        body: `Clone with PAT or SSH deploy keys (scrubbed after checkout), pull from private registries with per-source credentials, or start from one of ${templateCount} hub templates — ${certifiedCount} of them runtime-certified.`,
      },
      {
        icon: FileCode,
        title: ".ninedeploy manifest",
        body: "Commit build, runtime, routing, storage and alert config next to the code. Panel > manifest > auto-detect, so the file is a project default rather than a hard override — and a secret scanner refuses any credential-shaped value before it reaches git.",
      },
      {
        icon: RotateCcw,
        title: "Rollback & cancel",
        body: "Every deployment records the exact image digest — rollback redeploys that precise image, never a moved :latest. In-flight deploys cancel at any pipeline stage.",
      },
      {
        icon: CalendarClock,
        title: "Watch paths & cron",
        body: "Monorepo-friendly webhooks that only trigger on watched path globs. Cron-scheduled redeploys and container commands with run history.",
      },
      {
        icon: FileStack,
        title: "Live build logs",
        body: "WebSocket log streaming with backlog replay, a container exec terminal (xterm.js, admin-only, audited), and on-disk log persistence.",
      },
      {
        icon: Lock,
        title: "HMAC webhooks",
        body: "GitHub/GitLab/Gitea verification, branch matching, replay dedup — a captured push can't flood the deploy queue.",
      },
      {
        icon: Boxes,
        title: "1-Click Demo Stack",
        body: "Instant pre-configured demo stack with PostgreSQL database, Next.js Docker standalone container, and Next.js PM2 cluster service.",
      },
      {
        icon: GitBranch,
        title: "Ephemeral PR Previews",
        body: "Automatic isolated staging environments generated on pull request events with custom lifecycle hooks and teardown.",
      },
    ],
  },
  {
    title: "Data",
    items: [
      {
        icon: Database,
        title: "Extended Managed Databases",
        body: "PostgreSQL (pgvector), MySQL, MariaDB, Redis, Valkey, ClickHouse, Meilisearch, RabbitMQ, and MongoDB with one-click provisioning and Web Studio.",
      },
      {
        icon: FileCode,
        title: "Live Container File Manager",
        body: "Direct in-browser container filesystem explorer with file editing, drag-and-drop upload/download, and volume inspection.",
      },
      {
        icon: Layers,
        title: "Per-Service Volume Attachments",
        body: "A service mounts any number of managed Docker volumes at explicit container paths, read-only or read-write, with a uniqueness guard on both the path and the volume. Detaching unmounts — it never deletes the data.",
      },
      {
        icon: HardDrive,
        title: "Volume Snapshots & Restore",
        body: "Snapshot, restore and download any managed volume. Snapshots run through a throwaway sidecar so a containerised panel never needs a path into the daemon's storage, reuse the database backup destination for off-site copies, and refuse to restore under a running service.",
      },
      {
        icon: Copy,
        title: "Encrypted backups",
        body: "Dumps sealed with the master key the moment they hit disk. Daily scheduled backups keep the last 7; manual ones are never pruned.",
      },
      {
        icon: Boxes,
        title: "Off-site to any S3",
        body: "AWS, MinIO, Cloudflare R2, Backblaze B2 — via a dependency-free SigV4 client. Restore fetches the remote copy when the local file is gone.",
      },
      {
        icon: Server,
        title: "Single SQLite core",
        body: "All state in one .data directory. No PostgreSQL or Redis to babysit. Migrations apply automatically on every startup.",
      },
    ],
  },
  {
    title: "Network",
    items: [
      {
        icon: Globe,
        title: "Traefik ingress & Middlewares",
        body: "Dynamic routing with IP allowlists, Rate Limiting, Basic Auth, and custom security headers — only 80/443 exposed on the host.",
      },
      {
        icon: Network,
        title: "Direct Host Port Publishing",
        body: "Expose services directly on dedicated TCP/host ports (e.g. :8080 or :3000) without requiring a domain name or reverse proxy routing.",
      },
      {
        icon: ShieldCheck,
        title: "Wildcard SSL",
        body: "ACME DNS-01 via Cloudflare, DigitalOcean, Hetzner, Linode, Gandi or DuckDNS. One *.your-domain cert, HostRegexp routing, expiry badges.",
      },
      {
        icon: Network,
        title: "Cloudflare Tunnels",
        body: "Expose services without opening a single inbound port — managed cloudflared tunnels straight from the dashboard.",
      },
      {
        icon: FolderTree,
        title: "Projects & Architecture Topology",
        body: "Interactive React Flow diagrams on global topology, service details, and database ecosystems with live component inspectors and direct endpoint copying.",
      },
    ],
  },
  {
    title: "System",
    items: [
      {
        icon: Tag,
        title: "Tags Across Three Dimensions",
        body: "A service belongs to many projects, workspaces and labels at once. The top-bar filter composes all three — OR within a dimension, AND across them — and the selection persists per browser.",
      },
      {
        icon: FolderKanban,
        title: "Projects & Labels Management",
        body: "Flat, N-N project and label lists with their own pages: create, rename, recolour and delete without moving a single service. Shared project env vars resolve as the union of every project a service is linked to.",
      },
      {
        icon: Mail,
        title: "Workspace Invitations",
        body: "Invite an address that has no account yet — the invitation is accepted automatically on the invitee's next login or registration.",
      },
      {
        icon: Building2,
        title: "Workspaces & Team RBAC",
        body: "Organize applications across isolated workspaces, invite team members, and assign fine-grained roles (Owner, Admin, Member, Viewer).",
      },
      {
        icon: Shield,
        title: "SSO & OIDC Authentication",
        body: "Single Sign-On integration with Google, GitHub, Okta, and generic OpenID Connect providers with auto-enrollment toggles.",
      },
      {
        icon: HardDrive,
        title: "Log Drains & Auto-Prune",
        body: "Forward logs to Loki, Datadog, Vector, or Syslog in real time. Automatic disk cleanup pruning dangling images and old artifacts.",
      },
      {
        icon: Waypoints,
        title: "SSH Auto-Provisioner Fleet",
        body: "Register and zero-touch bootstrap remote Linux servers via SSH with automatic Docker installation and agent pairing.",
      },
      {
        icon: Boxes,
        title: "Microkernel & Plugin Hub",
        body: "Modular microkernel architecture with hot-swappable plugins, custom dashboard menus, extensible hooks, and dual-vault config store.",
      },
      {
        icon: KeyRound,
        title: "Serious auth & Passkeys",
        body: "Argon2id, Passkeys (WebAuthn), JWT with stateless revocation, TOTP 2FA, brute-force lockout (5 fails → 15 min), single-use reset links.",
      },
      {
        icon: ScrollText,
        title: "Audit everything",
        body: "Every destructive action lands in the audit log with retention bounds (90d). Per-service activity feeds and a global event stream.",
      },
      {
        icon: AlarmClockCheck,
        title: "Alerting",
        body: "Threshold rules on CPU, memory and cert-expiry with sustained-breach windows, one-shot firing, cooldown and recovery notifications.",
      },
      {
        icon: Bell,
        title: "Notifications",
        body: "Telegram, Discord, Slack, ntfy, SMTP email and generic webhooks — event filters, retries with backoff, delivery log.",
      },
      {
        icon: MonitorSmartphone,
        title: "Every interface",
        body: "Web dashboard (dark/light + 6 accents, ⌘K palette), ninedeploy CLI, REST API + typed SDK, and an MCP server with 38 tools for AI assistants.",
      },
    ],
  },
];

export function Features() {
  return (
    <>
      <section className="grid-bg border-b-2 border-edge dark:border-line">
        <div className="mx-auto max-w-7xl px-4 py-16 md:py-24">
          <div className="tag mb-3">the full manifest</div>
          <h1 className="text-4xl md:text-6xl font-bold tracking-tight">
            Everything, <span className="text-phosphor-dim">inventoried.</span>
          </h1>
          <p className="mt-4 max-w-2xl text-zinc-600 dark:text-zinc-400 text-lg">
            No paid tiers gating features — if it's in the list, it's in the
            box. Grouped the way the dashboard's icon rail groups them.
          </p>
        </div>
      </section>

      {groups.map((g, gi) => (
        <section
          key={g.title}
            className={
              gi % 2 === 1
                ? "border-y-2 border-edge dark:border-line bg-ink dark:bg-panel text-zinc-300"
                : ""
            }
        >
          <div className="mx-auto max-w-7xl px-4 py-14">
            <div className="flex items-center gap-3 mb-8">
              <span className="font-mono text-phosphor-dim text-sm">
                {String(gi + 1).padStart(2, "0")}
              </span>
              <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-ink dark:text-white">
                {g.title}
              </h2>
              <span className="flex-1 border-t-2 border-dashed border-black/20 dark:border-line" />
            </div>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
              {g.items.map((it) => (
                <article
                  key={it.title}
                  className="panel panel-hard p-5 hover:-translate-y-1 transition-transform"
                >
                  <it.icon size={22} className="text-ink dark:text-phosphor" strokeWidth={1.75} />
                  <h3 className="mt-3 font-bold">{it.title}</h3>
                  <p className="mt-1.5 text-sm text-zinc-600 dark:text-zinc-400 leading-relaxed">
                    {it.body}
                  </p>
                </article>
              ))}
            </div>
          </div>
        </section>
      ))}

      <section className="mx-auto max-w-4xl px-4 py-16 text-center">
        <TerminalIcon className="mx-auto text-phosphor-dim" />
        <h2 className="mt-4 text-2xl md:text-4xl font-bold">Convinced?</h2>
        <Link
          to="/docs/installation"
          className="mt-6 inline-block font-mono font-bold border-2 border-ink bg-ink text-white dark:border-phosphor dark:bg-phosphor dark:text-void px-6 py-3 hover:-translate-y-0.5 transition-transform"
        >
          install it →
        </Link>
      </section>
    </>
  );
}
