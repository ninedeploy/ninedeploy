import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import type { DeployPreset } from '../components/DeployWizard.js';

/**
 * The Deploy Wizard used to open only from the Services page and the Hub, so
 * a first-time user on the Dashboard (where setup lands them) had no visible
 * way to start a deploy. Every entry point — top bar, rail, sidebar, ⌘K,
 * Dashboard, the /new resource picker — now opens it the same way: by adding
 * `?deploy=<kind>` to the CURRENT url. The param is also a shareable deep link
 * (docs, CLI output): `?deploy=new` is the plain wizard, the other kinds open
 * it pre-set for one source (`?deploy=image`, `?deploy=compose`, …).
 *
 * `DeployLauncher` (mounted once, in Layout) consumes the param: it opens the
 * wizard and strips the param again, so closing is plain state and never a
 * navigation. That ordering matters — on success the wizard navigates to the
 * new service and THEN calls onClose; a close that rewrote the url would race
 * that navigation and drop the user back where they started.
 */
export const DEPLOY_PARAM = 'deploy';

export type DeployKind = 'new' | 'git' | 'github-app' | 'image' | 'compose' | 'dockerfile' | 'static' | 'pm2';

/** What each kind pre-selects in the wizard. Unknown values open the plain wizard. */
export const DEPLOY_PRESETS: Record<DeployKind, DeployPreset> = {
  new: {},
  git: { mode: 'repo' },
  'github-app': { mode: 'repo', source: 'github_app' },
  image: { type: 'docker', mode: 'image' },
  compose: { type: 'compose', mode: 'paste' },
  dockerfile: { type: 'docker', mode: 'repo', buildPack: 'dockerfile' },
  static: { type: 'docker', mode: 'repo', buildPack: 'static' },
  pm2: { type: 'pm2', mode: 'repo' },
};

const DeployWizard = lazy(() => import('../components/DeployWizard.js').then((m) => ({ default: m.DeployWizard })));

/** The current url with `?deploy=<kind>` added (other params kept). */
export function deployHref(pathname: string, search: string, kind: DeployKind = 'new'): string {
  const params = new URLSearchParams(search);
  params.set(DEPLOY_PARAM, kind);
  return `${pathname}?${params.toString()}`;
}

/** Returns a function that opens the Deploy Wizard over the current page. */
export function useOpenDeploy(): (kind?: DeployKind) => void {
  const navigate = useNavigate();
  const location = useLocation();
  return useCallback(
    (kind: DeployKind = 'new') => navigate(deployHref(location.pathname, location.search, kind)),
    [navigate, location.pathname, location.search],
  );
}

/** Returns a function that goes to the /new resource picker. */
export function useNewResource(): () => void {
  const navigate = useNavigate();
  return useCallback(() => navigate('/new'), [navigate]);
}

export function DeployLauncher() {
  const location = useLocation();
  const navigate = useNavigate();
  // A fresh object per open, so the wizard remounts with the new preset.
  const [open, setOpen] = useState<{ preset: DeployPreset } | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const kind = params.get(DEPLOY_PARAM);
    if (kind === null) return;
    setOpen({ preset: DEPLOY_PRESETS[kind as DeployKind] ?? {} });
    params.delete(DEPLOY_PARAM);
    const rest = params.toString();
    navigate(`${location.pathname}${rest ? `?${rest}` : ''}${location.hash}`, { replace: true });
  }, [location.pathname, location.search, location.hash, navigate]);

  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <DeployWizard key={JSON.stringify(open.preset)} preset={open.preset} onClose={() => setOpen(null)} />
    </Suspense>
  );
}
