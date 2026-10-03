/**
 * Manifest Creator — the project-side form editor for `.ninedeploy`.
 *
 * Layout:
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │ PageHeader: title + Import / Undo / Redo / Copy / Download /      │
 *   │             Preview / Reset actions                               │
 *   │ Live validation strip (rose issues + jump links, or emerald OK)   │
 *   │ PresetSelector (full width, cards with icons + meta chips)        │
 *   ├──────────────────┬───────────────────────────────────────────────┤
 *   │ Section nav      │ Active section form                           │
 *   │ (sticky, grouped │ + per-section schema issues                   │
 *   │ + progress)      │                                               │
 *   └──────────────────┴───────────────────────────────────────────────┘
 *
 * The page owns the manifest state via `useManifestForm` (undoable,
 * localStorage-backed). The zod schema runs live through `validateManifest`
 * so the operator sees exactly what the deploy pipeline will accept, and
 * the `Import` modal round-trips an existing `.ninedeploy` file back into
 * the form via `parseManifestYaml`.
 */
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import {
  formatManifestYaml,
  parseManifestYaml,
  ManifestValidationError,
  type NinedeployManifest,
} from '@ninedeploy/sdk';
import { NINEDEPLOY_MANIFEST_MAX_BYTES } from '@ninedeploy/schemas';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Code2,
  Copy,
  Download,
  FileCode,
  Redo2,
  RefreshCw,
  Sparkles,
  Undo2,
  Upload,
  X,
} from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardBody,
  Modal,
  PageHeader,
  PresetSelector,
  type PresetOption,
  Textarea,
  Tooltip,
  cn,
} from '../components/ui.js';
import { downloadBlob, useCopy } from '../lib/format.js';
import { PRESETS } from './manifestCreator/presets.js';
import { lintManifest } from './manifestCreator/secretScan.js';
import { YAML_TOKEN_CLASS, highlightYaml } from './manifestCreator/highlightYaml.js';
import { validateManifest } from './manifestCreator/validation.js';
import {
  SECTIONS,
  SECTION_GROUPS,
  loadActiveSection,
  saveActiveSection,
  useManifestForm,
  type SectionId,
} from './manifestCreator/state.js';
import { AlertsSection } from './manifestCreator/sections/AlertsSection.js';
import { BuildSection } from './manifestCreator/sections/BuildSection.js';
import { DatabaseSection } from './manifestCreator/sections/DatabaseSection.js';
import { EnvSection } from './manifestCreator/sections/EnvSection.js';
import { HooksSection } from './manifestCreator/sections/HooksSection.js';
import { NetworkSection } from './manifestCreator/sections/NetworkSection.js';
import { NotificationsSection } from './manifestCreator/sections/NotificationsSection.js';
import { PhasesSection } from './manifestCreator/sections/PhasesSection.js';
import { PreviewsSection } from './manifestCreator/sections/PreviewsSection.js';
import { ResourcesSection } from './manifestCreator/sections/ResourcesSection.js';
import { RoutingSection } from './manifestCreator/sections/RoutingSection.js';
import { RunSection } from './manifestCreator/sections/RunSection.js';
import { StaticSection } from './manifestCreator/sections/StaticSection.js';
import { VolumeSection } from './manifestCreator/sections/VolumeSection.js';
import { WatchSection } from './manifestCreator/sections/WatchSection.js';
import { RuntimeSection } from './manifestCreator/sections/RuntimeSection.js';

/**
 * r213: set a manifest section, or DROP it when the editor reports
 * `undefined`. Every section used to spread `...(x ? { x } : {})`, which keeps
 * the OLD value when a section is turned off or emptied — the Previews switch
 * stayed on, the last route/alert never left the YAML — short of a full reset.
 */
export function withSection<K extends keyof NinedeployManifest>(
  manifest: NinedeployManifest,
  key: K,
  value: NinedeployManifest[K] | undefined,
): NinedeployManifest {
  const next = { ...manifest };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

/**
 * Section registry: maps the section id to the form component. The order
 * matches `SECTIONS` (left-nav order). Keeping this in one place means
 * adding a new section is a one-liner in two adjacent objects.
 */
const SECTION_RENDERERS: Record<
  SectionId,
  (props: { manifest: NinedeployManifest; replace: (next: NinedeployManifest) => void }) => ReactNode
> = {
  runtime: ({ manifest, replace }) => (
    <RuntimeSection
      value={manifest.runtime}
      onChange={(runtime) => replace(withSection(manifest, 'runtime', runtime))}
    />
  ),
  build: ({ manifest, replace }) => (
    <BuildSection
      value={manifest.build}
      onChange={(build) => replace(withSection(manifest, 'build', build))}
    />
  ),
  run: ({ manifest, replace }) => (
    <RunSection
      value={manifest.run}
      onChange={(run) => replace(withSection(manifest, 'run', run))}
    />
  ),
  static: ({ manifest, replace }) => (
    <StaticSection
      value={manifest.static}
      onChange={(staticConfig) =>
        replace(withSection(manifest, 'static', staticConfig))
      }
    />
  ),
  env: ({ manifest, replace }) => (
    <EnvSection
      value={manifest.env}
      onChange={(env) => replace(withSection(manifest, 'env', env))}
    />
  ),
  phases: ({ manifest, replace }) => (
    <PhasesSection
      value={manifest.phases}
      onChange={(phases) => replace(withSection(manifest, 'phases', phases))}
    />
  ),
  resources: ({ manifest, replace }) => (
    <ResourcesSection
      value={manifest.resources}
      onChange={(resources) =>
        replace(withSection(manifest, 'resources', resources))
      }
    />
  ),
  hooks: ({ manifest, replace }) => (
    <HooksSection
      value={manifest.hooks}
      onChange={(hooks) => replace(withSection(manifest, 'hooks', hooks))}
    />
  ),
  watch: ({ manifest, replace }) => (
    <WatchSection
      value={manifest.watch}
      onChange={(watch) => replace(withSection(manifest, 'watch', watch))}
    />
  ),
  routing: ({ manifest, replace }) => (
    <RoutingSection
      value={manifest.routes}
      onChange={(routes) => replace(withSection(manifest, 'routes', routes))}
    />
  ),
  previews: ({ manifest, replace }) => (
    <PreviewsSection
      value={manifest.previews}
      onChange={(previews) => replace(withSection(manifest, 'previews', previews))}
    />
  ),
  volume: ({ manifest, replace }) => (
    <VolumeSection
      value={manifest.volume}
      onChange={(volume) => replace(withSection(manifest, 'volume', volume))}
    />
  ),
  database: ({ manifest, replace }) => (
    <DatabaseSection
      value={manifest.database}
      onChange={(database) => replace(withSection(manifest, 'database', database))}
    />
  ),
  network: ({ manifest, replace }) => (
    <NetworkSection
      value={manifest.network}
      onChange={(network) => replace(withSection(manifest, 'network', network))}
    />
  ),
  notifications: ({ manifest, replace }) => (
    <NotificationsSection
      value={manifest.notifications}
      onChange={(notifications) =>
        replace(withSection(manifest, 'notifications', notifications))
      }
    />
  ),
  alerts: ({ manifest, replace }) => (
    <AlertsSection
      value={manifest.alerts}
      onChange={(alerts) => replace(withSection(manifest, 'alerts', alerts))}
    />
  ),
};

export function ManifestCreator() {
  const { manifest, replace, reset, undo, redo, canUndo, canRedo } = useManifestForm();
  const [activeId, setActiveId] = useState<SectionId>(
    () => (loadActiveSection(SECTIONS.map((s) => s.id)) as SectionId | null) ?? 'runtime',
  );
  useEffect(() => {
    saveActiveSection(activeId);
  }, [activeId]);

  // When opened from a service detail tab via `?from=service:<id>` the
  // prefill flow loads the service's current build/run settings into the
  // form so the operator only has to fill in the fields the manifest
  // adds on top of the existing service config.
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const fromParam = params.get('from');
  const fromServiceId = fromParam?.startsWith('service:')
    ? Number.parseInt(fromParam.slice('service:'.length), 10)
    : null;
  const fromServiceIdSafe = Number.isFinite(fromServiceId) ? fromServiceId : null;
  const fromService = useQuery({
    queryKey: ['service-for-manifest', fromServiceIdSafe],
    queryFn: () => api.services.get(fromServiceIdSafe!),
    enabled: fromServiceIdSafe != null,
  });
  useEffect(() => {
    // Only prefill once (when the form is the empty starter and the
    // service query has resolved). Re-running this on every service
    // refetch would clobber user edits.
    if (!fromService.data) return;
    if (manifest.version !== '1' || Object.keys(manifest).length > 1) return;
    const svc = fromService.data;
    const seeded: NinedeployManifest = {
      version: '1',
      run: {
        port: svc.port ?? undefined,
        healthcheck: svc.healthPath ?? undefined,
      },
    };
    replace(seeded);
  }, [fromService.data, manifest, replace]);

  const [previewOpen, setPreviewOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importErrors, setImportErrors] = useState<string[] | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiDescription, setAiDescription] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { copy, copied } = useCopy(1500);

  const yaml = useMemo(() => formatManifestYaml(manifest), [manifest]);
  const lint = useMemo(() => lintManifest(manifest), [manifest]);
  const issues = useMemo(() => validateManifest(manifest), [manifest]);
  const issuesBySection = useMemo(() => {
    const map = new Map<SectionId, typeof issues>();
    for (const issue of issues) {
      if (!issue.sectionId) continue;
      const list = map.get(issue.sectionId) ?? [];
      list.push(issue);
      map.set(issue.sectionId, list);
    }
    return map;
  }, [issues]);
  const touched = Object.keys(manifest).length > 1;
  const configuredCount = SECTIONS.filter((s) => s.isFilled(manifest)).length;
  const highlighted = useMemo(() => highlightYaml(yaml), [yaml]);
  const yamlBytes = useMemo(() => new TextEncoder().encode(yaml).length, [yaml]);

  const presetOptions = useMemo<readonly PresetOption<NinedeployManifest>[]>(
    () =>
      PRESETS.map((p) => ({
        id: p.id,
        label: p.label,
        description: p.description,
        manifest: p.manifest,
        icon: <p.icon size={15} />,
        meta: p.meta,
      })),
    [],
  );
  const currentPresetId = useMemo(() => {
    const current = JSON.stringify(manifest);
    return PRESETS.find((p) => JSON.stringify(p.manifest) === current)?.id;
  }, [manifest]);

  const active = SECTIONS.find((s) => s.id === activeId) ?? SECTIONS[0]!;
  const renderSection = SECTION_RENDERERS[activeId];
  if (!renderSection) throw new Error(`No renderer for section ${active.id}`);
  const activeIssues = issuesBySection.get(activeId) ?? [];
  const brokenSections = SECTIONS.filter((s) => issuesBySection.has(s.id));

  const downloadFile = () => {
    downloadBlob(yaml, '.ninedeploy', 'text/yaml');
  };

  const runImport = (text: string) => {
    try {
      const parsed = parseManifestYaml(text);
      replace(parsed);
      setImportOpen(false);
      setImportText('');
      setImportErrors(null);
    } catch (err) {
      if (err instanceof ManifestValidationError) {
        setImportErrors(err.issues.map((i) => `${i.path || '<root>'}: ${i.message}`));
      } else {
        setImportErrors([err instanceof Error ? err.message : String(err)]);
      }
    }
  };

  const onImportFile = (file: File) => {
    file.text().then(runImport).catch(() => {
      setImportErrors([`Could not read "${file.name}".`]);
    });
  };

  // AI deploy assist: describe the app, merge the schema-validated manifest
  // over the draft. Sections the AI returns win; everything else survives.
  const runAiFill = async () => {
    setAiBusy(true);
    setAiError(null);
    try {
      const { manifest: suggested } = await api.ai.suggestManifest(aiDescription.trim());
      replace({ ...manifest, ...(suggested as Partial<NinedeployManifest>) });
      setAiOpen(false);
      setAiDescription('');
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'AI assist failed');
    } finally {
      setAiBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        icon={<FileCode size={18} />}
        title="Manifest Creator"
        subtitle="Project-side editor for .ninedeploy. The file is committed to the repo and read by the docker builder at deploy time."
        actions={
          <>
            <Tooltip content="Import an existing .ninedeploy file">
              <Button variant="secondary" size="md" onClick={() => setImportOpen(true)}>
                <Upload size={14} /> Import
              </Button>
            </Tooltip>
            <Tooltip content="Describe the app and let AI fill the manifest">
              <Button variant="secondary" size="md" onClick={() => setAiOpen(true)}>
                <Sparkles size={14} /> AI fill
              </Button>
            </Tooltip>
            <Tooltip content="Undo the last change">
              <Button variant="ghost" size="md" onClick={undo} disabled={!canUndo} aria-label="Undo">
                <Undo2 size={14} />
              </Button>
            </Tooltip>
            <Tooltip content="Redo an undone change">
              <Button variant="ghost" size="md" onClick={redo} disabled={!canRedo} aria-label="Redo">
                <Redo2 size={14} />
              </Button>
            </Tooltip>
            <Tooltip content="Copy the current YAML to the clipboard">
              <Button variant="secondary" size="md" onClick={() => copy(yaml)}>
                {copied ? (
                  <>
                    <Check size={14} /> Copied
                  </>
                ) : (
                  <>
                    <Copy size={14} /> Copy YAML
                  </>
                )}
              </Button>
            </Tooltip>
            <Button variant="secondary" size="md" onClick={downloadFile}>
              <Download size={14} /> Download
            </Button>
            <Button variant="secondary" size="md" onClick={() => setPreviewOpen(true)}>
              <Code2 size={14} /> Preview
            </Button>
            <Tooltip content="Reset to an empty manifest (can be undone)">
              <Button variant="ghost" size="md" onClick={reset}>
                <RefreshCw size={14} /> Reset
              </Button>
            </Tooltip>
          </>
        }
      />

      {/* Live validation: the exact schema the deploy pipeline enforces. */}
      {issues.length > 0 ? (
        <div className="mb-5 rounded-xl border border-rose-500/30 bg-rose-500/[0.06] p-3" role="alert">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-rose-300">
            <AlertTriangle size={14} />
            {issues.length} validation issue{issues.length === 1 ? '' : 's'}
          </div>
          <ul className="mt-1.5 space-y-0.5">
            {issues.map((issue, i) => (
              <li key={i} className="text-xs text-rose-200">
                {issue.path ? <code className="font-mono text-[11px]">{issue.path}</code> : 'manifest'}
                {': '}
                {issue.message}
              </li>
            ))}
          </ul>
          {brokenSections.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {brokenSections.map((s) => (
                <Button key={s.id} variant="secondary" size="sm" onClick={() => setActiveId(s.id)}>
                  Fix in {s.label}
                </Button>
              ))}
            </div>
          )}
        </div>
      ) : touched ? (
        <div className="mb-5 flex items-center gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.05] px-3 py-2 text-xs text-emerald-200">
          <CheckCircle2 size={14} className="shrink-0" />
          Manifest is valid — {configuredCount} of {SECTIONS.length} sections configured.
        </div>
      ) : null}

      <Card className="mb-5">
        <CardBody className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Sparkles size={14} className="text-indigo-300" />
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                Start from a preset
              </span>
            </div>
            <span className="text-[11px] text-slate-500">
              Applying a preset replaces the draft — Undo brings it back.
            </span>
          </div>
          <PresetSelector
            options={presetOptions}
            value={currentPresetId}
            onSelect={(preset) => replace(preset)}
          />
        </CardBody>
      </Card>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[15rem_1fr]">
        <aside className="lg:sticky lg:top-4 lg:self-start">
          <nav className="space-y-2.5 rounded-xl border border-white/[0.06] bg-white/[0.02] p-1.5">
            {SECTION_GROUPS.map((group) => (
              <div key={group.id}>
                <div className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-widest text-slate-600">
                  {group.label}
                </div>
                <div className="space-y-0.5">
                  {group.sectionIds.map((id) => {
                    const section = SECTIONS.find((s) => s.id === id)!;
                    const isActive = section.id === activeId;
                    const filled = section.isFilled(manifest);
                    const sectionIssueCount = issuesBySection.get(section.id)?.length ?? 0;
                    const Icon = section.icon;
                    return (
                      <button
                        key={section.id}
                        type="button"
                        data-section={section.id}
                        aria-label={`${section.label} section`}
                        onClick={() => setActiveId(section.id)}
                        className={cn(
                          'flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition',
                          isActive
                            ? 'bg-indigo-500/15 text-indigo-100 ring-1 ring-indigo-500/30'
                            : 'text-slate-300 hover:bg-white/[0.05] hover:text-slate-100',
                        )}
                      >
                        <Icon
                          size={14}
                          className={cn('mt-0.5 shrink-0', isActive ? 'text-indigo-300' : 'text-slate-500')}
                          aria-hidden
                        />
                        <span className="flex-1">
                          <span className="block font-medium">{section.label}</span>
                          <span className="block text-[11px] text-slate-500">{section.blurb}</span>
                        </span>
                        {sectionIssueCount > 0 ? (
                          <span className="mt-0.5 rounded-full bg-rose-500/20 px-1.5 text-[10px] font-semibold text-rose-300 ring-1 ring-inset ring-rose-500/30">
                            {sectionIssueCount}
                          </span>
                        ) : (
                          <span
                            className={cn(
                              'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
                              filled ? 'bg-emerald-400' : 'bg-slate-600',
                            )}
                            aria-hidden
                          />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>

          {/* Progress: how much of the manifest the operator has filled in. */}
          <div className="mt-3">
            <div className="mb-1 flex items-center justify-between text-[11px] text-slate-500">
              <span>
                {configuredCount}/{SECTIONS.length} sections configured
              </span>
              <span>{Math.round((configuredCount / SECTIONS.length) * 100)}%</span>
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-white/[0.08]">
              <div
                className="h-full rounded-full bg-emerald-400/80 transition-all"
                style={{ width: `${(configuredCount / SECTIONS.length) * 100}%` }}
              />
            </div>
          </div>

          <div className="mt-3 text-[11px] text-slate-500">
            <Badge tone={lint.length > 0 ? 'rose' : 'emerald'} className="mb-1.5">
              {lint.length > 0 ? `${lint.length} secret risk` : 'no secret risks'}
            </Badge>
            {lint.length > 0 && (
              <ul className="space-y-0.5">
                {lint.map((h, i) => (
                  <li key={i}>
                    <code className="font-mono text-[10px] text-rose-300">{h.path}</code>: {h.description}{' '}
                    <span className="text-slate-500">({h.redacted})</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>

        <Card>
          <CardBody>
            <div className="mb-4 flex items-start gap-2.5">
              <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-indigo-500/10 text-indigo-300 ring-1 ring-inset ring-indigo-500/20">
                <active.icon size={14} />
              </span>
              <div>
                <h2 className="text-sm font-semibold text-slate-100">{active.label}</h2>
                <p className="text-xs text-slate-500">{active.blurb}</p>
              </div>
            </div>
            {activeIssues.length > 0 && (
              <div className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/[0.06] p-3" role="alert">
                <ul className="space-y-0.5">
                  {activeIssues.map((issue, i) => (
                    <li key={i} className="text-xs text-rose-200">
                      {issue.path ? <code className="font-mono text-[11px]">{issue.path}</code> : 'manifest'}
                      {': '}
                      {issue.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {renderSection({ manifest, replace })}
          </CardBody>
        </Card>
      </div>

      <Modal
        title=".ninedeploy preview"
        onClose={() => setPreviewOpen(false)}
        wide
        open={previewOpen}
      >
        <div className="space-y-4">
          {lint.length > 0 ? (
            <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-3">
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-rose-300">
                {lint.length} potential secret risk
                {lint.length === 1 ? '' : 's'}
              </div>
              <ul className="space-y-0.5">
                {lint.map((h, i) => (
                  <li key={i} className="text-xs text-rose-200">
                    <code className="font-mono text-[11px]">{h.path}</code>: {h.description}{' '}
                    <span className="text-rose-400">({h.redacted})</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs text-emerald-200">
              No obvious secrets — the file is safe to commit.
            </div>
          )}
          <pre className="max-h-[60vh] overflow-auto rounded-lg border border-white/10 bg-black/50 p-3 text-xs leading-relaxed text-slate-200">
            {highlighted.map((line, i) => (
              <Fragment key={i}>
                <span className="mr-4 inline-block w-7 select-none text-right text-slate-600">
                  {i + 1}
                </span>
                {line.tokens.map((token, j) => (
                  <span key={j} className={YAML_TOKEN_CLASS[token.kind]}>
                    {token.text}
                  </span>
                ))}
                {'\n'}
              </Fragment>
            ))}
          </pre>
          <div className="flex items-center justify-between">
            <span
              className={cn(
                'text-[11px]',
                yamlBytes > NINEDEPLOY_MANIFEST_MAX_BYTES ? 'text-rose-300' : 'text-slate-500',
              )}
            >
              {yamlBytes} / {Math.round(NINEDEPLOY_MANIFEST_MAX_BYTES / 1024)} KiB — the loader
              refuses files above the cap.
            </span>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => copy(yaml)}>
                {copied ? <Check size={12} /> : <Copy size={12} />} Copy
              </Button>
              <Button variant="secondary" size="sm" onClick={downloadFile}>
                <Download size={12} /> Download
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setPreviewOpen(false)}>
                <X size={12} /> Close
              </Button>
            </div>
          </div>
        </div>
      </Modal>

      <Modal
        title="Import .ninedeploy YAML"
        onClose={() => {
          setImportOpen(false);
          setImportErrors(null);
        }}
        wide
        open={importOpen}
      >
        <div className="space-y-3">
          <p className="text-xs text-slate-500">
            Paste the contents of an existing <code className="font-mono">.ninedeploy</code> file —
            it is validated with the same schema the deploy pipeline uses, then loaded into the
            form.
          </p>
          <Textarea
            aria-label="YAML to import"
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            placeholder={'version: "1"\nruntime:\n  type: node\n  version: "22"\n…'}
            rows={12}
            className="font-mono text-xs"
          />
          {importErrors && (
            <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-3" role="alert">
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-rose-300">
                Could not import
              </div>
              <ul className="space-y-0.5">
                {importErrors.map((message, i) => (
                  <li key={i} className="text-xs text-rose-200">
                    {message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex items-center justify-between">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload size={12} /> Choose file…
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              aria-label="Import from file"
              accept=".ninedeploy,.yml,.yaml,.txt"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onImportFile(file);
                // Reset so picking the same file twice still fires onChange.
                e.target.value = '';
              }}
            />
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setImportOpen(false);
                  setImportErrors(null);
                }}
              >
                <X size={12} /> Cancel
              </Button>
              <Button size="sm" onClick={() => runImport(importText)}>
                <Check size={12} /> Import YAML
              </Button>
            </div>
          </div>
        </div>
      </Modal>

      <Modal
        title="Fill with AI"
        onClose={() => {
          setAiOpen(false);
          setAiError(null);
        }}
        open={aiOpen}
      >
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!aiBusy && aiDescription.trim().length >= 10) void runAiFill();
          }}
        >
          <p className="text-xs text-slate-500">
            Describe the app in plain language — stack, port, health endpoint, env vars. The
            suggestion is validated against the manifest schema before it reaches this form and is
            merged over your draft (Undo brings the old draft back).
          </p>
          <Textarea
            aria-label="App description"
            value={aiDescription}
            onChange={(e) => setAiDescription(e.target.value)}
            placeholder={'A Node 20 Express API listening on port 3000, healthcheck at /healthz, needs DATABASE_URL, cap it at 512 MiB.'}
            rows={5}
          />
          {aiError && (
            <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-3 text-xs text-rose-200" role="alert">
              {aiError}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                setAiOpen(false);
                setAiError(null);
              }}
            >
              <X size={12} /> Cancel
            </Button>
            <Button type="submit" size="sm" disabled={aiBusy || aiDescription.trim().length < 10}>
              <Sparkles size={12} /> {aiBusy ? 'Thinking…' : 'Generate manifest'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
