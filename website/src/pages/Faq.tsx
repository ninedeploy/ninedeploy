import * as Accordion from "@radix-ui/react-accordion";
import { ChevronDown } from "lucide-react";
import { certifiedCount, templateCount } from "../hub";

const faqs = [
  {
    q: "How is this different from Dokploy / Coolify?",
    a: "NineDeploy is deliberately smaller, faster, and stricter: a single SQLite core with zero external database dependencies, coverage floors enforced in CI across the entire monorepo (100% on the data, schema, SDK, CLI, MCP and plugin-sdk packages; 99% on the web dashboard; 95% on the server), a typed-operation agent protocol instead of raw arbitrary shell over the wire, digest-pinned rollbacks, and an integrated microkernel plugin SDK. If you want a self-hosted PaaS that reads like an enterprise-audited codebase, this is it.",
  },
  {
    q: "Does it really need only SQLite?",
    a: "Yes. All state — users, workspaces, services, deployments, metrics, alerting rules, and backups metadata — lives in one .data directory with a single SQLite file. WAL mode is handled synchronously so backup tarballs and point-in-time snapshots can safely copy the database cleanly.",
  },
  {
    q: "Can I run it in Docker?",
    a: `Yes — the published Docker image mounts the host Docker socket with a persistent /data volume. PM2-managed bare-metal services require the systemd install because they run natively on the host; Docker containers, Docker Compose stacks, and the ${templateCount} hub templates (${certifiedCount} runtime-certified) work in both modes.`,
  },
  {
    q: "How does zero-downtime blue-green deployment work?",
    a: "Docker services deploy blue-green: the new container is provisioned and healthchecked directly on the internal container network before Traefik dynamically flips routing. The old container is only retired after the switchover succeeds. If the healthcheck fails, the new container is purged and the healthy version continues serving without interruption.",
  },
  {
    q: "How do multi-server remote agents stay secure?",
    a: "Remote agents expose a strictly typed operation protocol (docker pull/build/run, compose up/down, git checkout, env injection). Requests never carry raw shell argv or executable binaries. Every operand is strictly regex-validated on both ends, and communications use timing-safe SHA-256 tokens.",
  },
  {
    q: "Is there an API, CLI, and AI integration for automation?",
    a: "Everything in NineDeploy is API-first. You get the /v1 REST API with bearer tokens, a typed TypeScript SDK, an interactive CLI (`ninedeploy`), and an official Model Context Protocol (MCP) server with 38 tools for AI assistants (Claude Desktop, Cursor, Antigravity, Cline) to manage deployments, metrics, and configurations.",
  },
  {
    q: "What authentication and Single Sign-On methods are supported?",
    a: "NineDeploy supports Passwordless Passkeys (WebAuthn / FIDO2), OpenID Connect (OIDC) SSO for Google, GitHub, Okta, Keycloak, and custom identity providers, plus RFC 6238 TOTP Two-Factor Authentication (2FA) and Argon2id password hashing with brute-force lockout protection.",
  },
  {
    q: "What happens to my data on upgrade?",
    a: "The installer automatically snapshots the SQLite database and encryption master keys to `.data/upgrade-backups/` before applying any changes. Migrations are strictly forward-only and self-applying, and the installer gates success on the `/health` endpoint before completing the upgrade.",
  },
  {
    q: "Can I deploy heavy templates (like n8n, Supabase, Postgres) on a 1GB/2GB RAM VPS?",
    a: "Yes. NineDeploy's one-click installer automatically detects low-memory Linux hosts and configures a 2GB swapfile so Docker can reliably extract large multi-layer images without triggering kernel OOM (Out Of Memory) kills.",
  },
];

export function Faq() {
  return (
    <>
      <section className="grid-bg border-b-2 border-edge dark:border-line">
        <div className="mx-auto max-w-4xl px-4 py-16">
          <div className="tag mb-3">man nine deploy</div>
          <h1 className="text-4xl md:text-6xl font-bold tracking-tight">FAQ</h1>
        </div>
      </section>
      <section className="mx-auto max-w-3xl px-4 py-14">
        <Accordion.Root type="single" collapsible className="border-2 border-edge dark:border-line">
          {faqs.map((f, i) => (
            <Accordion.Item
              key={f.q}
              value={f.q}
              className="border-b-2 border-edge dark:border-line last:border-b-0"
            >
              <Accordion.Header>
                <Accordion.Trigger className="group w-full flex items-center justify-between gap-4 px-5 py-4 text-left font-bold hover:bg-ink hover:text-white dark:hover:bg-line dark:hover:text-phosphor transition-colors">
                  <span className="flex items-baseline gap-3">
                    <span className="font-mono text-xs text-phosphor-dim shrink-0">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    {f.q}
                  </span>
                  <ChevronDown
                    size={16}
                    className="shrink-0 group-data-[state=open]:rotate-180 transition-transform"
                  />
                </Accordion.Trigger>
              </Accordion.Header>
              <Accordion.Content className="px-5 pb-5 pt-1 text-sm text-zinc-600 dark:text-zinc-400 leading-relaxed">
                {f.a}
              </Accordion.Content>
            </Accordion.Item>
          ))}
        </Accordion.Root>
      </section>
    </>
  );
}
