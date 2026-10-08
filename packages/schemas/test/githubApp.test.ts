import { describe, expect, it } from 'vitest';
import { providerBaseUrl } from '../src/common.js';
import {
  GITHUB_API_BASE_URL,
  GITHUB_WEB_BASE_URL,
  githubApp,
  githubAppCreate,
  githubAppInstallation,
  githubAppManifestComplete,
  githubAppManifestRequest,
  githubAppManifestResponse,
  githubAppPatch,
  githubAppPrivateKey,
  githubLogin,
  githubNumericId,
  githubPrivateKeyPem,
  githubRepoFullName,
  serviceGithubFeedbackPatch,
  serviceGithubLink,
  serviceGithubLinkPut,
  serviceGithubMigrate,
  serviceGithubStatus,
} from '../src/githubApp.js';
import { createSource, sourcePatch, source } from '../src/index.js';

const PKCS1 = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\nabc=\n-----END RSA PRIVATE KEY-----';
const PKCS8 = '-----BEGIN PRIVATE KEY-----\r\nMIIEvQIBADANBgkq\r\n-----END PRIVATE KEY-----';

describe('providerBaseUrl (0.13)', () => {
  it('accepts https and http bases, trimming whitespace and trailing slashes', () => {
    expect(providerBaseUrl.parse(' https://git.example.com/ ')).toBe('https://git.example.com');
    expect(providerBaseUrl.parse('https://ghe.example.com/gitea//')).toBe('https://ghe.example.com/gitea');
    // http is a server decision (private-egress flag), not a schema one.
    expect(providerBaseUrl.parse('http://10.0.0.5:3000')).toBe('http://10.0.0.5:3000');
  });

  it('refuses non-URLs, other schemes, credentials, query and fragment', () => {
    for (const bad of [
      '',
      'git.example.com',
      'ftp://git.example.com',
      'file:///etc/passwd',
      'https://user@git.example.com',
      'https://:pw@git.example.com',
      'https://git.example.com/?x=1',
      'https://git.example.com/#frag',
      `https://${'a'.repeat(2050)}.com`,
    ]) {
      expect(providerBaseUrl.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('sources baseUrl (0.13)', () => {
  it('createSource takes an optional baseUrl and still refuses the github_app type', () => {
    expect(createSource.parse({ name: 'g', type: 'gitea', token: 't', baseUrl: 'https://git.example.com/' }).baseUrl).toBe(
      'https://git.example.com',
    );
    expect(createSource.parse({ name: 'g', type: 'gitea' }).baseUrl).toBeUndefined();
    expect(createSource.safeParse({ name: 'g', type: 'gitea', baseUrl: 'ftp://x' }).success).toBe(false);
    expect(createSource.safeParse({ name: 'g', type: 'github_app' }).success).toBe(false);
  });

  it('sourcePatch sets or clears baseUrl', () => {
    expect(sourcePatch.parse({ baseUrl: 'https://git.example.com' }).baseUrl).toBe('https://git.example.com');
    expect(sourcePatch.parse({ baseUrl: null }).baseUrl).toBeNull();
    expect(sourcePatch.parse({})).toEqual({});
    expect(sourcePatch.safeParse({ baseUrl: 'javascript:alert(1)' }).success).toBe(false);
  });

  it('the source view tolerates rows with and without baseUrl', () => {
    const row = { id: 1, name: 's', type: 'github_app', hasToken: false, hasDeployKey: false, defaultBranch: null, createdAt: '2026-10-08T00:00:00.000Z' };
    expect(source.parse(row).baseUrl).toBeUndefined();
    expect(source.parse({ ...row, baseUrl: null }).baseUrl).toBeNull();
    expect(source.parse({ ...row, baseUrl: 'https://git.example.com' }).baseUrl).toBe('https://git.example.com');
  });
});

describe('GitHub primitives', () => {
  it('githubLogin follows GitHub login rules', () => {
    for (const ok of ['octo', 'Octo-Cat', 'a', 'a1-b2', 'x'.repeat(39)]) expect(githubLogin.safeParse(ok).success, ok).toBe(true);
    for (const bad of ['', '-octo', 'octo-', 'oc--to', 'oc/to', 'x'.repeat(40), '../evil']) {
      expect(githubLogin.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('githubNumericId is a positive safe integer', () => {
    expect(githubNumericId.safeParse(123456789012).success).toBe(true);
    for (const bad of [0, -1, 1.5, '12', Number.MAX_SAFE_INTEGER + 2]) expect(githubNumericId.safeParse(bad).success).toBe(false);
  });

  it('githubRepoFullName is owner/repo', () => {
    expect(githubRepoFullName.safeParse('octo/hello.world_x-1').success).toBe(true);
    for (const bad of ['octo', 'octo/', '/repo', 'a/b/c', 'octo/re po', '-x/y']) {
      expect(githubRepoFullName.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('githubPrivateKeyPem accepts PKCS#1 and PKCS#8 PEM and nothing else', () => {
    expect(githubPrivateKeyPem.parse(`\n${PKCS1}\n`)).toBe(PKCS1);
    expect(githubPrivateKeyPem.safeParse(PKCS8).success).toBe(true);
    for (const bad of [
      '',
      'not a key',
      '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
      '-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----',
      '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----',
      `-----BEGIN PRIVATE KEY-----\n${'a'.repeat(16400)}\n-----END PRIVATE KEY-----`,
    ]) {
      expect(githubPrivateKeyPem.safeParse(bad).success).toBe(false);
    }
  });
});

describe('manifest flow', () => {
  it('fills the github.com defaults for a personal App', () => {
    expect(githubAppManifestRequest.parse({ target: 'user' })).toEqual({
      target: 'user',
      webBaseUrl: GITHUB_WEB_BASE_URL,
      checks: false,
    });
  });

  it('needs org for an org App and refuses it for a personal one', () => {
    expect(
      githubAppManifestRequest.parse({ target: 'org', org: 'acme', webBaseUrl: 'https://ghe.acme.io/', apiBaseUrl: 'https://ghe.acme.io/api/v3', checks: true }),
    ).toEqual({ target: 'org', org: 'acme', webBaseUrl: 'https://ghe.acme.io', apiBaseUrl: 'https://ghe.acme.io/api/v3', checks: true });
    expect(githubAppManifestRequest.safeParse({ target: 'org' }).success).toBe(false);
    expect(githubAppManifestRequest.safeParse({ target: 'user', org: 'acme' }).success).toBe(false);
    expect(githubAppManifestRequest.safeParse({ target: 'org', org: 'a/b' }).success).toBe(false);
    expect(githubAppManifestRequest.safeParse({ target: 'team' }).success).toBe(false);
  });

  it('describes the manifest response', () => {
    const res = { postUrl: 'https://github.com/settings/apps/new?state=s', manifest: { name: 'NineDeploy x' }, state: 's' };
    expect(githubAppManifestResponse.parse(res)).toEqual(res);
  });

  it('pins the manifest code to URL-path-safe characters', () => {
    expect(githubAppManifestComplete.parse({ code: 'a1B2_c-3', state: 'x.y.z' })).toEqual({ code: 'a1B2_c-3', state: 'x.y.z' });
    for (const code of ['', '../app', 'a/b', 'a?b', 'x'.repeat(257)]) {
      expect(githubAppManifestComplete.safeParse({ code, state: 's' }).success, code).toBe(false);
    }
    expect(githubAppManifestComplete.safeParse({ code: 'abc', state: '' }).success).toBe(false);
  });
});

describe('manual App entry', () => {
  it('defaults both bases to github.com', () => {
    expect(githubAppCreate.parse({ name: ' My App ', appId: 42, privateKey: PKCS1 })).toEqual({
      name: 'My App',
      appId: 42,
      privateKey: PKCS1,
      webBaseUrl: GITHUB_WEB_BASE_URL,
      apiBaseUrl: GITHUB_API_BASE_URL,
    });
  });

  it('takes a GHES pair and the optional secrets', () => {
    const out = githubAppCreate.parse({
      name: 'GHES',
      appId: 7,
      privateKey: PKCS8,
      webhookSecret: 'whsec',
      clientId: 'Iv1.abc',
      clientSecret: 'cs',
      webBaseUrl: 'https://ghe.acme.io/',
      apiBaseUrl: 'https://ghe.acme.io/api/v3/',
    });
    expect(out).toMatchObject({ webBaseUrl: 'https://ghe.acme.io', apiBaseUrl: 'https://ghe.acme.io/api/v3', webhookSecret: 'whsec' });
  });

  it('refuses a lone base URL, a bad key or a bad app id', () => {
    expect(githubAppCreate.safeParse({ name: 'x', appId: 1, privateKey: PKCS1, webBaseUrl: 'https://ghe.acme.io' }).success).toBe(false);
    expect(githubAppCreate.safeParse({ name: 'x', appId: 1, privateKey: PKCS1, apiBaseUrl: 'https://ghe.acme.io/api/v3' }).success).toBe(false);
    expect(githubAppCreate.safeParse({ name: 'x', appId: 1, privateKey: 'nope' }).success).toBe(false);
    expect(githubAppCreate.safeParse({ name: 'x', appId: 0, privateKey: PKCS1 }).success).toBe(false);
    expect(githubAppCreate.safeParse({ name: '', appId: 1, privateKey: PKCS1 }).success).toBe(false);
    expect(githubAppCreate.safeParse({ name: 'x', appId: 1, privateKey: PKCS1, webhookSecret: '' }).success).toBe(false);
  });

  it('patch needs at least one field and lets null clear the client fields', () => {
    expect(githubAppPatch.parse({ name: 'n' })).toEqual({ name: 'n' });
    expect(githubAppPatch.parse({ clientId: null, clientSecret: null })).toEqual({ clientId: null, clientSecret: null });
    expect(githubAppPatch.safeParse({}).success).toBe(false);
    expect(githubAppPatch.safeParse({ name: undefined }).success).toBe(false);
  });

  it('private-key PUT validates the PEM', () => {
    expect(githubAppPrivateKey.parse({ privateKey: PKCS1 })).toEqual({ privateKey: PKCS1 });
    expect(githubAppPrivateKey.safeParse({ privateKey: 'x' }).success).toBe(false);
  });
});

describe('views carry no secret', () => {
  const app = {
    id: 1,
    name: 'NineDeploy panel',
    appId: 42,
    slug: 'ninedeploy-panel',
    clientId: 'Iv1.abc',
    ownerLogin: 'acme',
    ownerType: 'Organization',
    webBaseUrl: GITHUB_WEB_BASE_URL,
    apiBaseUrl: GITHUB_API_BASE_URL,
    htmlUrl: 'https://github.com/apps/ninedeploy-panel',
    permissions: { contents: 'read' },
    events: ['push'],
    webhookUrl: 'https://panel.example.com/v1/hooks/github-app/abcd',
    installUrl: 'https://github.com/apps/ninedeploy-panel/installations/new',
    hasPrivateKey: true,
    hasClientSecret: false,
    createdAt: 'now',
    updatedAt: 'now',
  };

  it('githubApp strips anything secret-shaped', () => {
    const parsed = githubApp.parse({ ...app, privateKeyEncrypted: 'x', webhookSecret: 'y', clientSecret: 'z' });
    expect(parsed).toEqual(app);
    // Only `has*` booleans may name a secret.
    for (const key of Object.keys(githubApp.shape)) {
      if (!key.startsWith('has')) expect(key).not.toMatch(/secret$|privateKey$|Encrypted$/i);
    }
  });

  it('githubAppInstallation', () => {
    const inst = {
      id: 1,
      githubAppId: 1,
      installationId: 99,
      accountLogin: 'acme',
      accountType: 'Organization',
      accountId: 5,
      repositorySelection: 'selected',
      permissions: null,
      sourceId: 3,
      suspendedAt: null,
      removedAt: null,
      configureUrl: 'https://github.com/organizations/acme/settings/installations/99',
      createdAt: 'now',
      updatedAt: 'now',
    };
    expect(githubAppInstallation.parse(inst)).toEqual(inst);
    expect(githubAppInstallation.safeParse({ ...inst, repositorySelection: 'some' }).success).toBe(false);
  });
});

describe('service link', () => {
  it('PUT takes a github_app source plus optional repo id, scope, watch paths and enabled', () => {
    expect(serviceGithubLinkPut.parse({ sourceId: 3 })).toEqual({ sourceId: 3 });
    expect(
      serviceGithubLinkPut.parse({ sourceId: 3, repoId: 1296269, tokenScope: 'installation', watchPaths: 'apps/web/**', enabled: false }),
    ).toEqual({ sourceId: 3, repoId: 1296269, tokenScope: 'installation', watchPaths: 'apps/web/**', enabled: false });
    expect(serviceGithubLinkPut.parse({ sourceId: 3, watchPaths: null }).watchPaths).toBeNull();
    expect(serviceGithubLinkPut.safeParse({}).success).toBe(false);
    expect(serviceGithubLinkPut.safeParse({ sourceId: 3, tokenScope: 'org' }).success).toBe(false);
    // Same glob guard as a webhook's watchPaths.
    expect(serviceGithubLinkPut.safeParse({ sourceId: 3, watchPaths: '**/**/**/**/**/x' }).success).toBe(false);
  });

  it('feedback PATCH toggles status and PR comment and needs one of them', () => {
    expect(serviceGithubFeedbackPatch.parse({ reportStatus: true })).toEqual({ reportStatus: true });
    expect(serviceGithubFeedbackPatch.parse({ reportStatus: false, prComment: true })).toEqual({ reportStatus: false, prComment: true });
    expect(serviceGithubFeedbackPatch.safeParse({}).success).toBe(false);
    expect(serviceGithubFeedbackPatch.safeParse({ prComment: 'yes' }).success).toBe(false);
  });

  it('migrate takes a source id', () => {
    expect(serviceGithubMigrate.parse({ sourceId: 9 })).toEqual({ sourceId: 9 });
    expect(serviceGithubMigrate.safeParse({ sourceId: 0 }).success).toBe(false);
  });

  it('status view wraps a link or null', () => {
    const link = {
      id: 1,
      serviceId: 2,
      installationRowId: 3,
      githubAppId: 4,
      sourceId: 5,
      repoId: 6,
      repoFullName: 'acme/web',
      enabled: true,
      tokenScope: 'repository',
      watchPaths: null,
      reportStatus: false,
      prComment: false,
      previousSourceId: null,
      active: true,
      createdAt: 'now',
      updatedAt: 'now',
    };
    expect(serviceGithubLink.parse(link)).toEqual(link);
    expect(serviceGithubStatus.parse({ link })).toEqual({ link });
    expect(serviceGithubStatus.parse({ link: null })).toEqual({ link: null });
  });
});
