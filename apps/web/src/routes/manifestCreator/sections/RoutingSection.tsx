import type { Route } from '@ninedeploy/schemas';
import { Field, Input, KeyValueEditor, ListEditor, Switch } from '../../../components/ui.js';

const createRoute = (): Route => ({
  host: '',
  path: '/',
  ssl: true,
});

/** Mirror of the schema's hostname check — used for the inline hint. */
const HOSTNAME_RE =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

function hostError(host: string): string | undefined {
  if (host === '') return undefined;
  if (host.length < 3) return 'Hostnames are at least 3 characters (e.g. app.example.com).';
  if (!HOSTNAME_RE.test(host)) return 'Must be a valid hostname — letters, digits, dots, dashes.';
  return undefined;
}

function pathError(path: string): string | undefined {
  if (path !== '' && !path.startsWith('/')) return 'Paths are absolute — they must start with "/".';
  return undefined;
}

export function RoutingSection({
  value,
  onChange,
}: {
  value: Route[] | undefined;
  onChange: (next: Route[] | undefined) => void;
}) {
  const items = value ?? [];
  return (
    <div className="space-y-3">
      <ListEditor<Route>
        value={items}
        onChange={(next) => onChange(next.length > 0 ? next : undefined)}
        createNew={createRoute}
        addLabel="Add route"
        emptyMessage="No routes yet — domains are provisioned from this list at deploy time."
        itemLabel={(r, i) => r.host || `Route ${i + 1}`}
        renderItem={(route, update) => (
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="Host" error={hostError(route.host)}>
                <Input
                  value={route.host}
                  placeholder="app.example.com"
                  onChange={(e) => update({ ...route, host: e.target.value })}
                />
              </Field>
              <Field label="Path" error={pathError(route.path)}>
                <Input
                  value={route.path}
                  placeholder="/"
                  onChange={(e) => update({ ...route, path: e.target.value })}
                />
              </Field>
              <div className="flex items-end pb-2">
                <Switch
                  checked={route.ssl}
                  onChange={(ssl) => update({ ...route, ssl })}
                  label="SSL"
                />
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="IP allowlist (CIDR, comma-separated)">
                <Input
                  value={(route.ipAllowlist ?? []).join(', ')}
                  placeholder="1.2.3.4/32, 10.0.0.0/8"
                  onChange={(e) => {
                    const raw = e.target.value.trim();
                    if (!raw) {
                      const { ipAllowlist: _drop, ...rest } = route;
                      void _drop;
                      update(rest);
                      return;
                    }
                    update({ ...route, ipAllowlist: raw.split(',').map((s) => s.trim()) });
                  }}
                />
              </Field>
              <Field label="Rate limit (req/s)">
                <Input
                  value={
                    route.rateLimit ? `${route.rateLimit.average}/${route.rateLimit.burst}` : ''
                  }
                  placeholder="50/100 (average/burst)"
                  onChange={(e) => {
                    const raw = e.target.value.trim();
                    if (!raw) {
                      const { rateLimit: _drop, ...rest } = route;
                      void _drop;
                      update(rest);
                      return;
                    }
                    const [a, b] = raw.split('/').map((s) => Number.parseInt(s, 10));
                    if (a != null && b != null && Number.isFinite(a) && Number.isFinite(b)) {
                      update({ ...route, rateLimit: { average: a, burst: b } });
                    }
                  }}
                />
              </Field>
            </div>
            <Field label="Custom response headers" hint="HSTS, X-Frame-Options, CSP, etc.">
              <KeyValueEditor
                value={route.headers ?? {}}
                keyPlaceholder="X-Frame-Options"
                valuePlaceholder="DENY"
                addLabel="Add header"
                onChange={(headers) => {
                  if (Object.keys(headers).length === 0) {
                    const { headers: _drop, ...rest } = route;
                    void _drop;
                    update(rest);
                    return;
                  }
                  update({ ...route, headers });
                }}
              />
            </Field>
          </div>
        )}
      />
    </div>
  );
}
