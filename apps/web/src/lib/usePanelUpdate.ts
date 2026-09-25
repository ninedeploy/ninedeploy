import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api.js';
import { useAuth } from './auth.js';
import { useToast } from '../components/Toast.js';

/**
 * Panel self-update orchestration, shared by the layout banner and the About
 * page. Owns the start mutation plus the observation loop that must outlive a
 * panel restart: while the updater runs, /v1/system/update-status fails to
 * answer entirely (the installer stops the service mid-way), so the poller is
 * configured to keep trying quietly and reconciliation happens on phase
 * transitions once the panel is back.
 */

const TARGET_KEY = 'ninedeploy.updateTarget';

function readLocalTarget(): string | null {
  try {
    return window.localStorage.getItem(TARGET_KEY);
  } catch {
    return null;
  }
}

function writeLocalTarget(version: string | null): void {
  try {
    if (version) window.localStorage.setItem(TARGET_KEY, version);
    else window.localStorage.removeItem(TARGET_KEY);
  } catch {
    /* storage unavailable — tracking falls back to server state alone */
  }
}

/** Tag whose "update available" strip the operator dismissed on this device. */
const DISMISS_KEY = 'ninedeploy.updateDismissed';

export function dismissAvailableUpdate(tag: string): void {
  try {
    window.localStorage.setItem(DISMISS_KEY, tag);
  } catch {
    /* ignore */
  }
}

function readDismissed(): string | null {
  try {
    return window.localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

/**
 * r291: the server keeps reporting a finished run's terminal phase until the
 * next update starts, so "we saw success/failed" is not news on its own. The
 * last run (phase:target:finishedAt) this browser already announced lives
 * here; a later page load or another tab stays quiet about it. Keyed on
 * finishedAt, so an operator who reloads mid-update still hears the outcome.
 */
const ANNOUNCED_KEY = 'ninedeploy.updateAnnounced';
/** Failed run whose banner the operator dismissed on this device. */
const FAILURE_DISMISSED_KEY = 'ninedeploy.updateFailureDismissed';

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — the outcome may be announced again next load */
  }
}

/**
 * Runs announced by some hook instance during THIS page load. The About page
 * mounts a second instance beside the banner; it still shows the result, just
 * without a second toast.
 */
const announcedThisPage = new Set<string>();

export type UpdatePhase = 'checking' | 'idle' | 'available' | 'starting' | 'updating' | 'done' | 'failed';

export function usePanelUpdate() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const enabled = user?.isOperator === true;

  // Availability (6h server cache; About/Settings share this query key).
  const check = useQuery({
    queryKey: ['update-check'],
    queryFn: () => api.system.updateCheck(),
    enabled,
    staleTime: 60_000,
    retry: false,
  });

  // Live run state. While the updater has the service stopped every request
  // errors — that is expected mid-update traffic, not a broken endpoint.
  const status = useQuery({
    queryKey: ['self-update-status'],
    queryFn: () => api.system.updateStatus(),
    enabled,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.phase === 'running' || readLocalTarget() ? 2_500 : 120_000,
  });

  const [phase, setPhase] = useState<UpdatePhase>('checking');
  const [errorTail, setErrorTail] = useState<string | null>(null);
  // Tracks which target we already toasted about so a re-render cannot repeat it.
  const settledTargetRef = useRef<string | null>(null);

  const startMutation = useMutation({
    mutationFn: (version: string) => api.system.updateStart(version),
    onSuccess: (_data, version) => {
      writeLocalTarget(version);
      setErrorTail(null);
      setPhase('updating');
      status.refetch();
    },
    onError: (err) => toast(err instanceof Error ? err.message : 'Could not start the update', 'error'),
  });

  // Reconcile observed server phases into UI phase + one-shot notifications.
  useEffect(() => {
    if (!enabled) {
      setPhase('checking');
      return;
    }
    const data = status.data;
    if (!data && status.isLoading) {
      setPhase('checking');
      return;
    }

    if (!data || data.supported === false) {
      setPhase((prev) => (prev === 'done' || prev === 'failed' ? prev : readLocalTarget() ? 'updating' : 'idle'));
      return;
    }

    switch (data.phase) {
      case 'running': {
        setErrorTail(null);
        setPhase('updating');
        break;
      }
      case 'success': {
        const target = data.targetVersion ?? readLocalTarget();
        if (!target) {
          setPhase('idle');
          break;
        }
        const run = `success:${target}:${data.finishedAt ?? ''}`;
        if (settledTargetRef.current === run) break;
        if (readStored(ANNOUNCED_KEY) === run && !announcedThisPage.has(run)) {
          // Announced on an earlier page load or in another tab: history, not
          // news. (The availability cache may still compare against the old
          // release, so never offer the version we already moved to.)
          const latest = check.data?.updateAvailable ? check.data.latest : null;
          setPhase(readLocalTarget() ? 'updating' : latest && latest !== target ? 'available' : 'idle');
          break;
        }
        settledTargetRef.current = run;
        writeLocalTarget(null);
        setErrorTail(null);
        setPhase('done');
        if (!announcedThisPage.has(run)) {
          announcedThisPage.add(run);
          writeStored(ANNOUNCED_KEY, run);
          toast(`NineDeploy updated to ${target} — all systems on the new release`, 'success');
          // The availability cache still reports the pre-update comparison for
          // up to 6h; force one refresh so every badge clears immediately.
          void api.system
            .updateCheck(true)
            .then((fresh) => queryClient.setQueryData(['update-check'], fresh))
            .catch(() => undefined);
        }
        window.setTimeout(() => setPhase((p) => (p === 'done' ? 'idle' : p)), 12_000);
        break;
      }
      case 'failed': {
        const target = data.targetVersion ?? readLocalTarget();
        if (!target) break;
        const run = `failed:${target}:${data.finishedAt ?? ''}`;
        if (settledTargetRef.current === run) break;
        if (readStored(FAILURE_DISMISSED_KEY) === run) {
          setPhase(readLocalTarget() ? 'updating' : check.data?.updateAvailable && check.data.latest ? 'available' : 'idle');
          break;
        }
        settledTargetRef.current = run;
        writeLocalTarget(null);
        setErrorTail(data.errorTail);
        setPhase('failed');
        // The failure banner stays up until dismissed; the toast fires once.
        if (readStored(ANNOUNCED_KEY) !== run) {
          writeStored(ANNOUNCED_KEY, run);
          toast(`The update to ${target} failed — the previous release keeps running`, 'error');
        }
        break;
      }
      default: {
        if (readLocalTarget()) {
          // A started run this tab never saw confirmed yet.
          setPhase('updating');
        } else if (check.data?.updateAvailable && check.data.latest) {
          setPhase('available');
        } else {
          setPhase(readLocalTarget() ? 'updating' : 'idle');
        }
      }
    }
  }, [enabled, status.data, status.isLoading, check.data, toast, queryClient]);

  const available =
    enabled &&
    check.data?.updateAvailable === true &&
    !!check.data.latest &&
    status.data?.supported !== false;

  return {
    /** true until the first auth + queries resolve */
    ready: enabled ? !!(status.data || status.isError) : false,
    supported: status.data?.supported !== false,
    supportReason: status.data?.reason,
    currentVersion: check.data?.current ?? status.data?.currentVersion,
    latestVersion: check.data?.latest ?? null,
    notesUrl: check.data?.notesUrl ?? null,
    /** The release this panel is moving/has moved to (survives reloads). */
    targetVersion: status.data?.targetVersion ?? readLocalTarget(),
    available,
    dismissedByUser: available && readDismissed() === check.data?.latest,
    dismissAvailable: () => {
      if (check.data?.latest) dismissAvailableUpdate(check.data.latest);
      setPhase('idle');
    },
    /** Recomputed from live data — survives reloads via localStorage marker. */
    phase,
    errorTail,
    starting: startMutation.isPending,
    startUpdating: (version: string) => startMutation.mutate(version),
    retryStatus: () => status.refetch(),
    clearFailure: () => {
      const run = settledTargetRef.current;
      if (run?.startsWith('failed:')) writeStored(FAILURE_DISMISSED_KEY, run);
      setPhase('idle');
    },
  };
}
