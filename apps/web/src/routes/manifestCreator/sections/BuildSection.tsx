import type { Build } from '@ninedeploy/schemas';
import { Field, Input } from '../../../components/ui.js';

/** Mirror of the schema's repoRelativePath check: `..` escapes the repo. */
function baseDirError(baseDir: string): string | undefined {
  if (baseDir !== '' && baseDir.split(/[\\/]/).includes('..')) {
    return 'The base directory must stay inside the repository — no ".." segments.';
  }
  return undefined;
}

export function BuildSection({
  value,
  onChange,
}: {
  value: Build | undefined;
  onChange: (next: Build | undefined) => void;
}) {
  const update = (patch: Partial<Build>) => onChange({ ...(value ?? {}), ...patch });
  return (
    <div className="space-y-4">
      <Field label="Install command">
        <Input
          value={value?.install ?? ''}
          placeholder="npm ci  /  pnpm install --frozen-lockfile  /  pip install -r requirements.txt"
          onChange={(e) => update({ install: e.target.value || undefined })}
        />
      </Field>
      <Field label="Build command">
        <Input
          value={value?.build ?? ''}
          placeholder="npm run build  /  pnpm build  /  go build -o app ."
          onChange={(e) => update({ build: e.target.value || undefined })}
        />
      </Field>
      <Field label="Start command">
        <Input
          value={value?.start ?? ''}
          placeholder="node server.js  /  npm start  /  ./app"
          onChange={(e) => update({ start: e.target.value || undefined })}
        />
      </Field>
      <Field
        label="Base directory"
        hint="Relative to repo root; e.g. apps/web"
        error={baseDirError(value?.baseDir ?? '')}
      >
        <Input
          value={value?.baseDir ?? ''}
          placeholder="leave empty for repo root"
          onChange={(e) => update({ baseDir: e.target.value || undefined })}
        />
      </Field>
      <Field label="Dockerfile override" hint="Set only if you want Nixpacks to use a specific Dockerfile">
        <Input
          value={value?.dockerfile ?? ''}
          placeholder="docker/Dockerfile.prod"
          onChange={(e) => update({ dockerfile: e.target.value || undefined })}
        />
      </Field>
    </div>
  );
}
