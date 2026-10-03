/**
 * Runtime section of the Manifest Creator: language + pinned version.
 *
 * The version control is deliberately a picker *plus* a free-text escape
 * hatch. Suggestions come from `RUNTIME_VERSION_CATALOG`, which carries the
 * upstream support state of each version, so the recommended pin is one
 * click away — but an operator reproducing a legacy app can still choose an
 * end-of-life version, or type one the catalog has never heard of. Nothing
 * here blocks a build; unsupported versions get an advisory line, not an error.
 */
import { useState } from 'react';
import type { Runtime, RuntimeType } from '@ninedeploy/schemas';
import {
  RUNTIME_CATALOG_REVIEWED,
  findRuntimeVersion,
  recommendedRuntimeVersion,
  runtimeVersionAdvisory,
  runtimeVersionOptions,
} from '@ninedeploy/schemas';
import { Badge, Field, Input, Select } from '../../../components/ui.js';

const RUNTIME_TYPES: readonly { value: RuntimeType; label: string }[] = [
  { value: 'auto', label: 'Auto-detect (let Nixpacks decide)' },
  { value: 'node', label: 'Node.js' },
  { value: 'python', label: 'Python' },
  { value: 'go', label: 'Go' },
  { value: 'ruby', label: 'Ruby' },
  { value: 'php', label: 'PHP' },
  { value: 'java', label: 'Java' },
  { value: 'rust', label: 'Rust' },
  { value: 'static', label: 'Static (no runtime pin)' },
];

/** Sentinel `<option>` value that switches the picker to the free-text input. */
const CUSTOM_OPTION = '__custom__';

/** Advisory level → Badge tone. `error` still only warns; it never blocks. */
const ADVISORY_TONE = {
  error: 'rose',
  warn: 'amber',
  info: 'sky',
} as const;

const ADVISORY_LABEL = {
  error: 'End of life',
  warn: 'Security fixes only',
  info: 'Unverified',
} as const;

export function RuntimeSection({
  value,
  onChange,
}: {
  value: Runtime | undefined;
  onChange: (next: Runtime | undefined) => void;
}) {
  const type = value?.type ?? 'auto';
  const version = value?.version ?? '';
  const options = runtimeVersionOptions(type);
  const inCatalog = version !== '' && findRuntimeVersion(type, version) !== undefined;

  // Free-text mode is sticky once entered, but starts on whenever the current
  // pin is something the catalog does not list — otherwise the picker would
  // silently misrepresent a version the operator deliberately typed.
  const [custom, setCustom] = useState(version !== '' && !inCatalog);
  const showInput = options.length === 0 || custom || (version !== '' && !inCatalog);

  const advisory = runtimeVersionAdvisory(type, version || undefined);
  const recommended = recommendedRuntimeVersion(type);

  const emit = (nextType: RuntimeType, nextVersion: string) => {
    onChange(nextVersion ? { type: nextType, version: nextVersion } : { type: nextType });
  };

  const changeType = (next: RuntimeType) => {
    setCustom(false);
    // A pin only means something for the runtime it was picked for: carrying
    // "24" from Node across to Python would pin a version that does not exist.
    const keep = version !== '' && findRuntimeVersion(next, version) ? version : '';
    emit(next, keep);
  };

  const changeVersionOption = (next: string) => {
    if (next === CUSTOM_OPTION) {
      setCustom(true);
      return;
    }
    setCustom(false);
    emit(type, next);
  };

  return (
    <div className="space-y-4">
      <Field label="Type" hint="What runtime Nixpacks should pin">
        <Select value={type} onChange={(e) => changeType(e.target.value as RuntimeType)}>
          {RUNTIME_TYPES.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        label="Version"
        hint={
          recommended
            ? `Recommended: ${recommended}. Older versions stay selectable — support status is shown below.`
            : 'Major, major.minor, or major.minor.patch — e.g. 24 or 3.14'
        }
      >
        <div className="space-y-2">
          {options.length > 0 && (
            <Select
              aria-label="Runtime version"
              value={showInput ? CUSTOM_OPTION : version}
              onChange={(e) => changeVersionOption(e.target.value)}
            >
              <option value="">Let Nixpacks decide (no pin)</option>
              {options.map((opt) => (
                <option key={opt.version} value={opt.version}>
                  {opt.label}
                  {opt.version === recommended ? ' — recommended' : ''}
                </option>
              ))}
              <option value={CUSTOM_OPTION}>Other version…</option>
            </Select>
          )}
          {showInput && (
            <Input
              value={version}
              placeholder="leave empty to let Nixpacks pick"
              onChange={(e) => emit(type, e.target.value.trim())}
            />
          )}
        </div>
      </Field>

      {advisory && (
        <div className="flex items-start gap-2 rounded-lg border border-slate-700/60 bg-slate-900/40 p-3">
          <Badge tone={ADVISORY_TONE[advisory.level]}>{ADVISORY_LABEL[advisory.level]}</Badge>
          <p className="text-xs leading-relaxed text-slate-300">{advisory.message}</p>
        </div>
      )}

      <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.06] p-3">
        <p className="text-xs leading-relaxed text-slate-300">
          <span className="font-semibold text-amber-300">Not applied at build time yet.</span>{' '}
          The deploy pipeline applies this file's routes, alerts and database sections, but the
          builder does not yet read <code className="text-slate-200">runtime</code>. Declare it for
          documentation and forward compatibility; to pin a version today use your ecosystem's own
          mechanism (<code className="text-slate-200">.nvmrc</code>,{' '}
          <code className="text-slate-200">go.mod</code>,{' '}
          <code className="text-slate-200">composer.json</code>).
        </p>
      </div>

      <p className="text-[11px] text-slate-500">
        Version catalog last reviewed {RUNTIME_CATALOG_REVIEWED}.
      </p>
    </div>
  );
}
