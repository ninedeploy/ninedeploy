import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Bell, Check, ChevronDown, ChevronUp, GitBranch, Globe, HardDrive, Link2, Lock, type LucideIcon, Rocket, Server, X,
} from 'lucide-react';
import { Link } from 'react-router';
import type { OnboardingStepId } from '@ninedeploy/sdk';
import { api } from '../lib/api.js';
import { useOpenDeploy } from '../lib/deployLauncher.js';
import { cn } from './ui.js';

interface StepCopy {
  title: string;
  hint: string;
  cta: string;
  icon: LucideIcon;
  /** A route, or 'deploy' to open the Deploy Wizard. */
  to: string | 'deploy';
}

const STEPS: Record<OnboardingStepId, StepCopy> = {
  auto_url: {
    title: 'Give services a URL',
    hint: 'Free sslip.io test URLs or your wildcard domain — no DNS work per app.',
    cta: 'Set up',
    icon: Link2,
    to: '/settings?section=security',
  },
  git_source: {
    title: 'Connect your Git provider',
    hint: 'GitHub App, GitLab, Gitea or Bitbucket — private repos and push-to-deploy.',
    cta: 'Connect',
    icon: GitBranch,
    to: '/sources',
  },
  first_service: {
    title: 'Create your first service',
    hint: 'From a Git repo, a Docker image, a Compose file or one of 300+ templates.',
    cta: 'New service',
    icon: Rocket,
    to: 'deploy',
  },
  first_deploy: {
    title: 'See it go live',
    hint: 'The first successful build and health check.',
    cta: 'Open queue',
    icon: Server,
    to: '/deploys',
  },
  custom_domain: {
    title: 'Add your own domain',
    hint: 'Point a DNS record here and attach it to a service.',
    cta: 'Domains',
    icon: Globe,
    to: '/domains',
  },
  https: {
    title: 'Turn on HTTPS',
    hint: "Set a Let's Encrypt email; certificates are issued and renewed automatically.",
    cta: 'Set email',
    icon: Lock,
    to: '/settings?section=security',
  },
  notifications: {
    title: 'Get notified',
    hint: 'Deploy results and alerts in Slack, Discord, Telegram, email and more.',
    cta: 'Add channel',
    icon: Bell,
    to: '/settings?section=notifications',
  },
  backups: {
    title: 'Back up your data',
    hint: 'An S3 destination for database, volume and panel backups.',
    cta: 'Add destination',
    icon: HardDrive,
    to: '/backups',
  },
};

/**
 * 0.16.1 Getting started: the operator's setup checklist on the Dashboard,
 * every step derived server-side (`GET /v1/onboarding`). Hidden once dismissed;
 * collapsed by default once the required steps are done.
 */
export function GettingStartedCard() {
  const qc = useQueryClient();
  const openDeploy = useOpenDeploy();
  const q = useQuery({ queryKey: ['onboarding'], queryFn: () => api.onboarding.get(), refetchInterval: 15_000 });
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const dismiss = useMutation({
    mutationFn: (dismissed: boolean) => api.onboarding.setDismissed(dismissed),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['onboarding'] }),
  });

  const data = q.data;
  if (!data || data.completed === data.total) return null;
  // Hidden, but never lost: one quiet line brings the checklist back.
  if (data.dismissed) {
    return (
      <button
        type="button"
        onClick={() => dismiss.mutate(false)}
        disabled={dismiss.isPending}
        className="text-xs text-slate-500 transition hover:text-slate-300"
      >
        Setup: {data.completed} of {data.total} done · Show checklist
      </button>
    );
  }
  const open = expanded ?? !data.ready;
  const pct = Math.round((data.completed / data.total) * 100);
  const nextStep = data.steps.find((s) => !s.done && !s.optional) ?? data.steps.find((s) => !s.done);

  return (
    <section aria-label="Getting started" className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-indigo-300">Getting started</p>
          <h2 className="text-base font-semibold text-white">
            {data.ready ? 'Your panel is ready — a few extras left' : 'Set up your panel'}
          </h2>
          <div className="mt-2 flex items-center gap-3">
            <div
              className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/5"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={data.total}
              aria-valuenow={data.completed}
              aria-label="Setup progress"
            >
              <div className="h-full rounded-full bg-indigo-500 transition-all duration-500" style={{ width: `${Math.max(4, pct)}%` }} />
            </div>
            <span className="shrink-0 text-xs tabular-nums text-slate-400">
              {data.completed} of {data.total}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setExpanded(!open)}
          aria-expanded={open}
          aria-label={open ? 'Collapse checklist' : 'Expand checklist'}
          className="rounded-lg p-1.5 text-slate-500 transition hover:bg-white/[0.06] hover:text-slate-300"
        >
          {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
        <button
          type="button"
          onClick={() => dismiss.mutate(true)}
          disabled={dismiss.isPending}
          aria-label="Hide the checklist"
          title="Hide the checklist (a link on the Dashboard brings it back)"
          className="rounded-lg p-1.5 text-slate-500 transition hover:bg-white/[0.06] hover:text-slate-300"
        >
          <X size={16} />
        </button>
      </div>

      {open && (
        <ol className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-2">
          {data.steps.map((s) => {
            const copy = STEPS[s.id];
            const Icon = copy.icon;
            const isNext = s.id === nextStep?.id;
            const cta = (
              <span
                className={cn(
                  'shrink-0 rounded-lg px-2.5 py-1 text-xs font-medium transition',
                  isNext ? 'bg-indigo-500 text-white hover:bg-indigo-400' : 'bg-white/[0.05] text-slate-300 hover:bg-white/[0.1]',
                )}
              >
                {copy.cta}
              </span>
            );
            return (
              <li
                key={s.id}
                className={cn(
                  'flex items-center gap-3 rounded-xl border px-3 py-2.5',
                  s.done ? 'border-white/[0.04] bg-transparent' : isNext ? 'border-indigo-500/30 bg-indigo-500/[0.06]' : 'border-white/[0.06] bg-white/[0.02]',
                )}
              >
                <span
                  className={cn(
                    'grid h-7 w-7 shrink-0 place-items-center rounded-full',
                    s.done ? 'bg-emerald-500/15 text-emerald-300' : 'bg-white/[0.05] text-slate-400',
                  )}
                >
                  {s.done ? <Check size={14} /> : <Icon size={14} />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className={cn('flex items-center gap-1.5 text-sm font-medium', s.done ? 'text-slate-500 line-through' : 'text-slate-200')}>
                    {copy.title}
                    {s.optional && !s.done && <span className="text-[10px] font-normal text-slate-500 no-underline">optional</span>}
                  </div>
                  {!s.done && <div className="truncate text-xs text-slate-500">{copy.hint}</div>}
                </div>
                {!s.done &&
                  (copy.to === 'deploy' ? (
                    <button type="button" onClick={() => openDeploy()} aria-label={`${copy.cta}: ${copy.title}`}>
                      {cta}
                    </button>
                  ) : (
                    <Link to={copy.to} aria-label={`${copy.cta}: ${copy.title}`}>
                      {cta}
                    </Link>
                  ))}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
