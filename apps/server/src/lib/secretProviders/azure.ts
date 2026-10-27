import { azureProviderConfig } from '@ninedeploy/schemas';
import { providerFetch, parseJson, TokenCache, type NamedCallOptions, type NamedSecretDriver } from './named.js';
import { SecretProviderError } from './vault.js';

/**
 * G3.2: Azure Key Vault, `${{azure:<name>[@<version>]}}`.
 *
 * An app registration (tenant id, client id, client secret) gets a token for
 * the vault through the OAuth client-credentials flow at Microsoft Entra ID,
 * then reads `GET <vaultUrl>/secrets/<name>[/<version>]`. The vault URL is
 * limited by the schema to Key Vault hosts, and the login host follows the
 * vault's cloud, so the client secret only ever goes to Microsoft. The app
 * needs the "Key Vault Secrets User" role (or a get-secret access policy).
 */

type AzureConfig = { vaultUrl: string; tenantId: string; clientId: string };

const API_VERSION = '7.4';

/** Entra ID host and token scope of the vault's cloud. */
function cloudOf(vaultUrl: string): { login: string; scope: string } {
  const host = new URL(vaultUrl).hostname;
  if (host.endsWith('.vault.azure.cn')) return { login: 'https://login.chinacloudapi.cn', scope: 'https://vault.azure.cn/.default' };
  if (host.endsWith('.vault.usgovcloudapi.net')) return { login: 'https://login.microsoftonline.us', scope: 'https://vault.usgovcloudapi.net/.default' };
  return { login: 'https://login.microsoftonline.com', scope: 'https://vault.azure.net/.default' };
}

const tokens = new TokenCache();

async function accessToken(config: AzureConfig, creds: Record<string, string>, opts: NamedCallOptions): Promise<string> {
  const secret = creds['clientSecret'];
  if (!secret) throw new SecretProviderError('No Azure client secret is stored');
  return tokens.get(opts.cacheKey, async () => {
    const { login, scope } = cloudOf(config.vaultUrl);
    const { text } = await providerFetch(
      'Microsoft Entra ID token request',
      `${login}/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: config.clientId, client_secret: secret, scope }).toString(),
        signal: opts.signal,
      },
      [secret],
    );
    const body = parseJson('Microsoft Entra ID', text);
    if (typeof body['access_token'] !== 'string') throw new SecretProviderError('Microsoft Entra ID answered without an access token');
    return { token: body['access_token'], expiresInSeconds: typeof body['expires_in'] === 'number' ? body['expires_in'] : 3600 };
  });
}

async function readSecret(config: AzureConfig, creds: Record<string, string>, name: string, opts: NamedCallOptions): Promise<string> {
  const m = /^([A-Za-z0-9-]{1,127})(?:@([0-9a-fA-F]{32}))?$/.exec(name);
  if (!m) throw new SecretProviderError('Invalid Azure Key Vault reference (expected <name> or <name>@<version>)');
  const token = await accessToken(config, creds, opts);
  const url = `${config.vaultUrl}/secrets/${m[1]}${m[2] ? `/${m[2]}` : ''}?api-version=${API_VERSION}`;
  const { text } = await providerFetch('Azure Key Vault', url, { headers: { authorization: `Bearer ${token}` }, signal: opts.signal }, [
    creds['clientSecret'],
    token,
  ]);
  const value = parseJson('Azure Key Vault', text)['value'];
  if (typeof value !== 'string') throw new SecretProviderError('Azure Key Vault answered without a value');
  return value;
}

export const azureDriver: NamedSecretDriver<AzureConfig> = {
  kind: 'azure',
  label: 'Azure Key Vault',
  credentialFields: ['clientSecret'],
  requiredCredentials: ['clientSecret'],
  parseConfig: (raw) => {
    const parsed = azureProviderConfig.safeParse(raw);
    return parsed.success ? parsed.data : null;
  },
  validate: () => undefined,
  // A client secret belongs to one app registration in one tenant.
  target: (c) => `${c.tenantId}/${c.clientId}`,
  read: readSecret,
  async test(config, creds, opts) {
    tokens.delete(opts.cacheKey);
    await accessToken(config, creds, opts);
    let detail = 'Client credentials accepted';
    if (opts.probeName) {
      await readSecret(config, creds, opts.probeName, opts);
      detail += '; probe secret readable';
    }
    return detail;
  },
  clearCache: () => tokens.clear(),
};
