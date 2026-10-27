import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Lock, PlugZap, Save, Trash2 } from 'lucide-react';
import type { SecretProviderKind, SecretProviderTestResult, SecretProviderView } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { formatDateTime } from '../../lib/format.js';
import { useToast } from '../../components/Toast.js';
import { fill, useT, type Translate } from '../../lib/i18n.js';
import { Badge, Button, Card, CardBody, ConfirmDialog, ErrorCard, Field, Input, Select, Skeleton, Switch, Textarea } from '../../components/ui.js';

// `${{…}}` examples, escaped per repo convention so linters don't read them as template placeholders.
const OPEN = '${{';
const CLOSE = '}}';
export const REF_VAULT = `${OPEN}vault:path/to/secret#field${CLOSE}`;
export const REF_AWS = `${OPEN}aws:secret-id${CLOSE}`;
export const REF_AWS_KEY = `${OPEN}aws:secret-id#jsonKey${CLOSE}`;
// G3.2
export const REF_SSM = `${OPEN}ssm:/path/to/parameter${CLOSE}`;
export const REF_GCP = `${OPEN}gcp:secret[@version]${CLOSE}`;
export const REF_AZURE = `${OPEN}azure:secret-name${CLOSE}`;
export const REF_OP = `${OPEN}op:vault/item/field${CLOSE}`;
export const REF_EXEC = `${OPEN}exec:name${CLOSE}`;
const NAME_PLACEHOLDER = '{name}';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
/** Only the non-blank fields: a blank credential keeps the stored value. */
function filled(fields: Record<string, string>): Record<string, string> | undefined {
  const out = Object.fromEntries(Object.entries(fields).filter(([, v]) => v.trim() !== '').map(([k, v]) => [k, v.trim()]));
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Settings → Integrations → Secret managers (0.14, operator only): HashiCorp
 * Vault / OpenBao (KV v2) and AWS Secrets Manager. They run beside the
 * Infisical / Doppler provider above. Credentials are write-only: the list
 * never returns them, and a blank credential field keeps the stored value.
 */
export function SecretManagersCard() {
  const providers = useQuery({ queryKey: ['secret-providers'], queryFn: () => api.settings.secretProviders.list() });
  const byKind = (kind: SecretProviderKind) => providers.data?.find((p) => p.kind === kind);
  const vault = byKind('vault');
  const aws = byKind('aws');
  const gcp = byKind('gcp');
  const azure = byKind('azure');
  const onePassword = byKind('onepassword');
  const exec = byKind('exec');
  const t = useT();
  const code = (ref: string) => <code className="rounded bg-white/5 px-1 font-mono text-[10px]">{ref}</code>;

  return (
    <Card className="mb-5">
      <CardBody>
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
          <Lock size={14} /> {t('Secret managers')}
        </h2>
        <div className="mb-4 space-y-1 text-xs text-slate-500">
          <p>
            {fill(
              t('Reference secrets from any env value as {vault} (path relative to the KV v2 mount), {aws} or {awsKey} (a key of a JSON secret). Values are fetched at deploy time and never stored.'),
              { vault: code(REF_VAULT), aws: code(REF_AWS), awsKey: code(REF_AWS_KEY) },
            )}
          </p>
          <p>
            {fill(
              t('Also {ssm} (Parameter Store, with the AWS credentials), {gcp}, {azure}, {op} and {exec}; all but op take a {jsonKey} too.'),
              {
                ssm: code(REF_SSM),
                gcp: code(REF_GCP),
                azure: code(REF_AZURE),
                op: code(REF_OP),
                exec: code(REF_EXEC),
                jsonKey: <code className="font-mono text-[10px]">#jsonKey</code>,
              },
            )}
          </p>
          <p>
            {t('While a provider is not configured (or is disabled) its references stay literal and the deploy log warns. The “Allowed workspaces” list above governs these providers too.')}
          </p>
        </div>
        {providers.isLoading ? (
          <Skeleton className="h-32" />
        ) : providers.isError || !vault || !aws ? (
          <ErrorCard title={t('Could not load the secret managers')} error={providers.error} onRetry={() => void providers.refetch()} />
        ) : (
          <div className="grid gap-5 lg:grid-cols-2">
            <VaultPanel view={vault} />
            <AwsPanel view={aws} />
            {gcp ? <GcpPanel view={gcp} /> : null}
            {azure ? <AzurePanel view={azure} /> : null}
            {onePassword ? <OnePasswordPanel view={onePassword} /> : null}
            {exec ? <ExecPanel view={exec} /> : null}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

// ── shared shell: status, enabled switch, save / test / remove ─────────────

interface ShellProps {
  view: SecretProviderView;
  title: string;
  enabled: boolean;
  onEnabled: (v: boolean) => void;
  canSave: boolean;
  onSave: () => Promise<unknown>;
  /** Clears the write-only credential inputs after a save. */
  onSaved: () => void;
  probeLabel: string;
  probeField: 'probePath' | 'probeSecretId' | 'probeName';
  children: ReactNode;
}

function ProviderShell({ view, title, enabled, onEnabled, canSave, onSave, onSaved, probeLabel, probeField, children }: ShellProps) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const t = useT();
  const [probe, setProbe] = useState('');
  const [result, setResult] = useState<SecretProviderTestResult | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['secret-providers'] });
  /** A stored row (an unconfigured kind answers `config: {}`). */
  const saved = Object.keys(view.config).length > 0;

  const save = useMutation({
    mutationFn: onSave,
    onSuccess: () => {
      onSaved();
      setResult(null);
      refresh();
      toast(t('{title} saved', { title }), 'success');
    },
    onError: (err) => toast(err instanceof Error ? err.message : t('Save failed'), 'error'),
  });
  const test = useMutation({
    mutationFn: () => api.settings.secretProviders.test(view.kind, probe.trim() ? { [probeField]: probe.trim() } : {}),
    onSuccess: (res) => {
      setResult(res);
      refresh();
    },
    onError: (err) => toast(err instanceof Error ? err.message : t('Test failed'), 'error'),
  });
  const remove = useMutation({
    mutationFn: () => api.settings.secretProviders.delete(view.kind),
    onSuccess: () => {
      setResult(null);
      refresh();
      toast(t('{title} removed', { title }), 'success');
    },
    onError: (err) => toast(err instanceof Error ? err.message : t('Remove failed'), 'error'),
  });

  return (
    <div className="rounded-lg border border-white/[0.06] p-4" data-testid={`secret-provider-${view.kind}`}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-200">{title}</h3>
        <Badge tone={view.configured ? 'emerald' : 'neutral'}>{view.configured ? t('configured') : t('not configured')}</Badge>
      </div>
      <div className="grid gap-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-slate-400">{t('Resolve references')}</span>
          <Switch checked={enabled} onChange={onEnabled} label={t('{title} enabled', { title })} />
        </div>
        {children}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending || !canSave}>
            <Save size={12} /> {save.isPending ? t('Saving…') : t('Save')}
          </Button>
          {saved ? (
            <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(true)} disabled={remove.isPending}>
              <Trash2 size={12} /> {t('Remove')}
            </Button>
          ) : null}
        </div>
        <div className="border-t border-white/[0.06] pt-3">
          <Field label={probeLabel} hint={t('optional')}>
            <Input value={probe} onChange={(e) => setProbe(e.target.value)} className="font-mono text-xs" />
          </Field>
          <div className="mt-2 flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => test.mutate()} disabled={test.isPending || !saved}>
              <PlugZap size={12} /> {test.isPending ? t('Testing…') : t('Test connection')}
            </Button>
          </div>
          {result ? (
            <p className={`mt-2 text-xs ${result.ok ? 'text-emerald-300' : 'text-rose-300'}`} data-testid={`secret-provider-${view.kind}-result`}>
              {result.ok ? t('OK: ') : t('Failed: ')}
              {result.detail}
            </p>
          ) : view.lastTestedAt ? (
            <p className={`mt-2 text-xs ${view.lastTestError ? 'text-rose-300' : 'text-slate-500'}`}>
              {t('Last tested {when}', { when: formatDateTime(view.lastTestedAt) })}
              {view.lastTestError ? `: ${view.lastTestError}` : ' — OK'}
            </p>
          ) : null}
        </div>
      </div>
      <ConfirmDialog
        open={confirmRemove}
        title={t('Remove {title}?', { title })}
        message={t('Its stored credentials are deleted. Deploys keep its references literal (with a warning) until it is configured again.')}
        confirmLabel={t('Remove')}
        onConfirm={() => remove.mutate()}
        onClose={() => setConfirmRemove(false)}
      />
    </div>
  );
}

const credentialHint = (t: Translate, stored: boolean) => (stored ? t('stored — blank keeps it') : undefined);

// ── HashiCorp Vault / OpenBao ──────────────────────────────────────────────

function VaultPanel({ view }: { view: SecretProviderView }) {
  const t = useT();
  const c = view.config;
  const [enabled, setEnabled] = useState(view.configured ? view.enabled : true);
  const [address, setAddress] = useState(str(c['address']));
  const [namespace, setNamespace] = useState(str(c['namespace']));
  const [mount, setMount] = useState(str(c['mount']) || 'secret');
  const [authMethod, setAuthMethod] = useState<'token' | 'approle'>(c['authMethod'] === 'approle' ? 'approle' : 'token');
  const [approleMount, setApproleMount] = useState(str(c['approleMount']) || 'approle');
  const [token, setToken] = useState('');
  const [roleId, setRoleId] = useState('');
  const [secretId, setSecretId] = useState('');
  const stored = view.hasCredential && c['authMethod'] === authMethod;
  const credsReady = stored || (authMethod === 'token' ? token.trim() !== '' : roleId.trim() !== '' && secretId.trim() !== '');

  const onSave = () => {
    const credentials = filled(authMethod === 'token' ? { token } : { roleId, secretId });
    return api.settings.secretProviders.set('vault', {
      enabled,
      config: {
        address: address.trim(),
        mount: mount.trim() || 'secret',
        authMethod,
        ...(namespace.trim() ? { namespace: namespace.trim() } : {}),
        ...(authMethod === 'approle' ? { approleMount: approleMount.trim() || 'approle' } : {}),
      },
      ...(credentials ? { credentials } : {}),
    });
  };

  return (
    <ProviderShell
      view={view}
      title="HashiCorp Vault / OpenBao"
      enabled={enabled}
      onEnabled={setEnabled}
      canSave={address.trim() !== '' && credsReady}
      onSave={onSave}
      onSaved={() => {
        setToken('');
        setRoleId('');
        setSecretId('');
      }}
      probeLabel={t('Probe path')}
      probeField="probePath"
    >
      <Field label={t('Vault address')} hint="https">
        <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="https://vault.example.com:8200" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('KV v2 mount')}>
          <Input value={mount} onChange={(e) => setMount(e.target.value)} className="font-mono text-xs" />
        </Field>
        <Field label={t('Namespace')} hint={t('optional')}>
          <Input value={namespace} onChange={(e) => setNamespace(e.target.value)} className="font-mono text-xs" />
        </Field>
      </div>
      <Field label={t('Auth method')}>
        <Select value={authMethod} onChange={(e) => setAuthMethod(e.target.value as 'token' | 'approle')}>
          <option value="token">{t('Token')}</option>
          <option value="approle">AppRole</option>
        </Select>
      </Field>
      {authMethod === 'token' ? (
        <Field label={t('Vault token')} hint={credentialHint(t, stored)}>
          <Input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder={stored ? '••••••••' : 'hvs.…'} />
        </Field>
      ) : (
        <>
          <Field label={t('AppRole mount')}>
            <Input value={approleMount} onChange={(e) => setApproleMount(e.target.value)} className="font-mono text-xs" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('Role ID')} hint={credentialHint(t, stored)}>
              <Input type="password" autoComplete="off" value={roleId} onChange={(e) => setRoleId(e.target.value)} placeholder={stored ? '••••••••' : ''} />
            </Field>
            <Field label={t('Secret ID')} hint={credentialHint(t, stored)}>
              <Input type="password" autoComplete="off" value={secretId} onChange={(e) => setSecretId(e.target.value)} placeholder={stored ? '••••••••' : ''} />
            </Field>
          </div>
        </>
      )}
      <p className="text-[11px] text-slate-500">
        {t('A token is not renewed: use a periodic token or AppRole. An http address or a private IP needs NINEDEPLOY_ALLOW_PRIVATE_EGRESS=1.')}
      </p>
    </ProviderShell>
  );
}

// ── AWS Secrets Manager ────────────────────────────────────────────────────

function AwsPanel({ view }: { view: SecretProviderView }) {
  const t = useT();
  const c = view.config;
  const [enabled, setEnabled] = useState(view.configured ? view.enabled : true);
  const [region, setRegion] = useState(str(c['region']));
  const [endpoint, setEndpoint] = useState(str(c['endpoint']));
  const [roleArn, setRoleArn] = useState(str(c['roleArn']));
  const [externalId, setExternalId] = useState(str(c['externalId']));
  const [roleSessionName, setRoleSessionName] = useState(str(c['roleSessionName']));
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [sessionToken, setSessionToken] = useState('');
  const stored = view.hasCredential;
  const credsReady = stored || (accessKeyId.trim() !== '' && secretAccessKey.trim() !== '');

  const onSave = () => {
    const credentials = filled({ accessKeyId, secretAccessKey, sessionToken });
    const optional = filled({ endpoint, roleArn, externalId, roleSessionName });
    return api.settings.secretProviders.set('aws', {
      enabled,
      config: { region: region.trim(), ...optional },
      ...(credentials ? { credentials } : {}),
    });
  };

  return (
    <ProviderShell
      view={view}
      title="AWS Secrets Manager"
      enabled={enabled}
      onEnabled={setEnabled}
      canSave={region.trim() !== '' && credsReady}
      onSave={onSave}
      onSaved={() => {
        setAccessKeyId('');
        setSecretAccessKey('');
        setSessionToken('');
      }}
      probeLabel={t('Probe secret id')}
      probeField="probeSecretId"
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('Region')}>
          <Input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="eu-west-1" className="font-mono text-xs" />
        </Field>
        <Field label={t('Endpoint')} hint={t('optional, https')}>
          <Input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} className="font-mono text-xs" />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('Access key ID')} hint={credentialHint(t, stored)}>
          <Input type="password" autoComplete="off" value={accessKeyId} onChange={(e) => setAccessKeyId(e.target.value)} placeholder={stored ? '••••••••' : 'AKIA…'} />
        </Field>
        <Field label={t('Secret access key')} hint={credentialHint(t, stored)}>
          <Input type="password" autoComplete="off" value={secretAccessKey} onChange={(e) => setSecretAccessKey(e.target.value)} placeholder={stored ? '••••••••' : ''} />
        </Field>
      </div>
      <Field label={t('Session token')} hint={t('optional')}>
        <Input type="password" autoComplete="off" value={sessionToken} onChange={(e) => setSessionToken(e.target.value)} />
      </Field>
      <Field label={t('Assume role ARN')} hint={t('optional')}>
        <Input value={roleArn} onChange={(e) => setRoleArn(e.target.value)} placeholder="arn:aws:iam::123456789012:role/ninedeploy" className="font-mono text-xs" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('External ID')} hint={t('needs a role')}>
          <Input value={externalId} onChange={(e) => setExternalId(e.target.value)} className="font-mono text-xs" />
        </Field>
        <Field label={t('Role session name')}>
          <Input value={roleSessionName} onChange={(e) => setRoleSessionName(e.target.value)} placeholder="ninedeploy" className="font-mono text-xs" />
        </Field>
      </div>
      <p className="text-[11px] text-slate-500">{t('Instance and ECS roles (IMDS) are not supported: use an access key, optionally with an assumed role.')}</p>
    </ProviderShell>
  );
}

// ── G3.2: GCP Secret Manager ───────────────────────────────────────────────

function GcpPanel({ view }: { view: SecretProviderView }) {
  const t = useT();
  const [enabled, setEnabled] = useState(view.configured ? view.enabled : true);
  const [projectId, setProjectId] = useState(str(view.config['projectId']));
  const [serviceAccountJson, setServiceAccountJson] = useState('');
  const stored = view.hasCredential;

  return (
    <ProviderShell
      view={view}
      title="GCP Secret Manager"
      enabled={enabled}
      onEnabled={setEnabled}
      canSave={stored || serviceAccountJson.trim() !== ''}
      onSave={() => {
        const credentials = filled({ serviceAccountJson });
        return api.settings.secretProviders.set('gcp', {
          enabled,
          config: projectId.trim() ? { projectId: projectId.trim() } : {},
          ...(credentials ? { credentials } : {}),
        });
      }}
      onSaved={() => setServiceAccountJson('')}
      probeLabel={t('Probe secret')}
      probeField="probeName"
    >
      <Field label={t('Project ID')} hint={t('optional, defaults to the project of the key')}>
        <Input value={projectId} onChange={(e) => setProjectId(e.target.value)} placeholder="my-project" className="font-mono text-xs" />
      </Field>
      <Field label={t('Service account key (JSON)')} hint={credentialHint(t, stored)}>
        <Textarea
          aria-label={t('Service account key (JSON)')}
          value={serviceAccountJson}
          onChange={(e) => setServiceAccountJson(e.target.value)}
          placeholder={stored ? '••••••••' : '{"type": "service_account", …}'}
          rows={4}
          className="font-mono text-[11px]"
        />
      </Field>
      <p className="text-[11px] text-slate-500">{t('The account needs Secret Manager Secret Accessor on the secrets it reads.')}</p>
    </ProviderShell>
  );
}

// ── G3.2: Azure Key Vault ──────────────────────────────────────────────────

function AzurePanel({ view }: { view: SecretProviderView }) {
  const t = useT();
  const c = view.config;
  const [enabled, setEnabled] = useState(view.configured ? view.enabled : true);
  const [vaultUrl, setVaultUrl] = useState(str(c['vaultUrl']));
  const [tenantId, setTenantId] = useState(str(c['tenantId']));
  const [clientId, setClientId] = useState(str(c['clientId']));
  const [clientSecret, setClientSecret] = useState('');
  // A stored secret belongs to one app registration and one vault: changing any of them needs it again.
  const stored =
    view.hasCredential &&
    c['tenantId'] === tenantId.trim() &&
    c['clientId'] === clientId.trim() &&
    str(c['vaultUrl']).toLowerCase() === vaultUrl.trim().replace(/\/+$/, '').toLowerCase();

  return (
    <ProviderShell
      view={view}
      title="Azure Key Vault"
      enabled={enabled}
      onEnabled={setEnabled}
      canSave={vaultUrl.trim() !== '' && tenantId.trim() !== '' && clientId.trim() !== '' && (stored || clientSecret.trim() !== '')}
      onSave={() => {
        const credentials = filled({ clientSecret });
        return api.settings.secretProviders.set('azure', {
          enabled,
          config: { vaultUrl: vaultUrl.trim(), tenantId: tenantId.trim(), clientId: clientId.trim() },
          ...(credentials ? { credentials } : {}),
        });
      }}
      onSaved={() => setClientSecret('')}
      probeLabel={t('Probe secret')}
      probeField="probeName"
    >
      <Field label={t('Vault URL')}>
        <Input value={vaultUrl} onChange={(e) => setVaultUrl(e.target.value)} placeholder="https://my-vault.vault.azure.net" className="font-mono text-xs" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('Tenant ID')}>
          <Input value={tenantId} onChange={(e) => setTenantId(e.target.value)} className="font-mono text-xs" />
        </Field>
        <Field label={t('Client ID')}>
          <Input value={clientId} onChange={(e) => setClientId(e.target.value)} className="font-mono text-xs" />
        </Field>
      </div>
      <Field label={t('Client secret')} hint={credentialHint(t, stored)}>
        <Input type="password" autoComplete="off" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder={stored ? '••••••••' : ''} />
      </Field>
      <p className="text-[11px] text-slate-500">{t('The app registration needs the Key Vault Secrets User role (or a get-secret access policy).')}</p>
    </ProviderShell>
  );
}

// ── G3.2: 1Password Connect ────────────────────────────────────────────────

function OnePasswordPanel({ view }: { view: SecretProviderView }) {
  const t = useT();
  const [enabled, setEnabled] = useState(view.configured ? view.enabled : true);
  const [address, setAddress] = useState(str(view.config['address']));
  const [token, setToken] = useState('');
  // A stored token is never sent to another server.
  const stored = view.hasCredential && str(view.config['address']).replace(/\/+$/, '') === address.trim().replace(/\/+$/, '');

  return (
    <ProviderShell
      view={view}
      title="1Password Connect"
      enabled={enabled}
      onEnabled={setEnabled}
      canSave={address.trim() !== '' && (stored || token.trim() !== '')}
      onSave={() => {
        const credentials = filled({ token });
        return api.settings.secretProviders.set('onepassword', {
          enabled,
          config: { address: address.trim() },
          ...(credentials ? { credentials } : {}),
        });
      }}
      onSaved={() => setToken('')}
      probeLabel={t('Probe reference (vault/item/field)')}
      probeField="probeName"
    >
      <Field label={t('Connect server')} hint="https">
        <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="https://connect.example.com" />
      </Field>
      <Field label={t('Access token')} hint={credentialHint(t, stored)}>
        <Input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder={stored ? '••••••••' : 'eyJ…'} />
      </Field>
      <p className="text-[11px] text-slate-500">{t('A Connect server on a private network needs NINEDEPLOY_ALLOW_PRIVATE_EGRESS=1 (http as well).')}</p>
    </ProviderShell>
  );
}

// ── G3.2: exec command ─────────────────────────────────────────────────────

function ExecPanel({ view }: { view: SecretProviderView }) {
  const t = useT();
  const c = view.config;
  const [enabled, setEnabled] = useState(view.configured ? view.enabled : true);
  const [command, setCommand] = useState(Array.isArray(c['command']) ? (c['command'] as string[]).join('\n') : '');
  const [timeoutSeconds, setTimeoutSeconds] = useState(String(typeof c['timeoutSeconds'] === 'number' ? c['timeoutSeconds'] : 10));
  const argv = command
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const timeout = Number(timeoutSeconds);

  return (
    <ProviderShell
      view={view}
      title={t('exec command')}
      enabled={enabled}
      onEnabled={setEnabled}
      canSave={argv.length > 0 && argv[0]!.startsWith('/') && Number.isInteger(timeout) && timeout >= 1 && timeout <= 60}
      onSave={() => api.settings.secretProviders.set('exec', { enabled, config: { command: argv, timeoutSeconds: timeout } })}
      onSaved={() => undefined}
      probeLabel={t('Probe name')}
      probeField="probeName"
    >
      <Field label={t('Command')} hint={t('one argument per line; {name} is the reference name', { name: NAME_PLACEHOLDER })}>
        <Textarea
          aria-label={t('Command')}
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder={['/usr/local/bin/bw', 'get', 'password', NAME_PLACEHOLDER].join('\n')}
          rows={4}
          className="font-mono text-[11px]"
        />
      </Field>
      <Field label={t('Timeout (seconds)')}>
        <Input aria-label={t('Timeout (seconds)')} value={timeoutSeconds} onChange={(e) => setTimeoutSeconds(e.target.value)} inputMode="numeric" className="w-24 font-mono text-xs" />
      </Field>
      <p className="text-[11px] text-slate-500">
        {t('Runs on the panel host without a shell; its stdout is the value. Off unless the panel was started with NINEDEPLOY_SECRET_EXEC=1.')}
      </p>
    </ProviderShell>
  );
}
