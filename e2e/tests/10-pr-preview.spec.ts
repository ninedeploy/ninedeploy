import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, perLayout, test } from './fixtures';
import { apiGet, sessionToken, watch, type Deploy } from './support';

type Branch = { name: string; commit: string };
type Service = { id: number; name: string; slug: string; runtimeId: string | null; previewDeploymentsEnabled: boolean; previewParentServiceId: number | null };
type Deployment = Deploy & { commitSha: string };
type Hook = { id: number; secret: string };
type Opened = { action: string; previewServiceId: number; deploymentId: number };
type Traffic = { status: number; body: string };

const routeProbe = `
  const http = require('node:http');
  const request = http.get({hostname:process.argv[1], port:80, headers:{host:process.argv[2]}, timeout:3000}, response => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', chunk => { body += chunk; if (body.length > 32768) request.destroy(); });
    response.on('end', () => console.log(JSON.stringify({status:response.statusCode, body})));
  });
  request.on('timeout', () => request.destroy(new Error('preview route deadline')));
  request.on('error', error => { console.error(error.message); process.exitCode = 1; });
`;

const docker = (args: string[]) => execFileSync('docker', args,
  { encoding: 'utf8', timeout: 15_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const slowPoll = { timeout: 180_000, intervals: [1_000, 2_000, 5_000] };
const deployments = (page: Page, service: number) => apiGet<Deployment[]>(page, `/v1/services/${service}/deploys`);

// N10: the compact project repeats this journey too, under its own parent service.
test('N08 PR preview: a signed Git event serves its branch, a broken build shows its failure, and closing removes both previews', async ({ page, layout }) => {
  test.setTimeout(600_000);
  const fixture = JSON.parse(process.env.ND_E2E_GIT ?? 'null') as { container: string; main: string; preview: Branch; broken: Branch } | null;
  const dind = process.env.ND_E2E_DIND;
  expect(fixture?.container).toMatch(/^nd-e2e-git-[0-9a-f]{8}$/);
  expect(dind).toBe(fixture!.container.replace('-git-', '-dind-'));
  const git = fixture!;
  const inner = (args: string[]) => docker(['exec', dind!, 'docker', '-H', 'tcp://127.0.0.1:2375', ...args]);
  const repoUrl = `http://${git.container}:8080/repo.git`;
  const gitRequests = () => Number(docker(['exec', git.container, 'node', '-e',
    "fetch('http://127.0.0.1:8080/health',{signal:AbortSignal.timeout(3000)}).then(async r=>console.log((await r.json()).requests))"]));
  const visit = (hostname: string): Traffic =>
    JSON.parse(docker(['exec', git.container, 'node', '-e', routeProbe, dind!, hostname]));

  const w = watch(page);
  await page.goto('/services');
  const authorization = { authorization: `Bearer ${await sessionToken(page)}` };
  async function post<T>(path: string, data: Record<string, unknown>) {
    const response = await page.request.post(path, { headers: authorization, data });
    expect(response.ok(), `POST ${path}: HTTP ${response.status()}`).toBe(true);
    return await response.json() as T;
  }
  const name = perLayout(layout, 'n08-git-parent');
  const parent = await post<Service>('/v1/services', {
    name, type: 'docker', repoUrl, branch: 'main', port: 8080, build: { buildPack: 'dockerfile' },
  });
  const original = await post<{ deploymentId: number }>(`/v1/services/${parent.id}/deploys`, {});
  await expect.poll(async () => (await deployments(page, parent.id)).find(row => row.id === original.deploymentId), slowPoll)
    .toMatchObject({ status: 'running', commitSha: git.main });
  const parentHost = `${perLayout(layout, 'n08-parent-control')}.n08.test`;
  await post(`/v1/services/${parent.id}/domains`, { hostname: parentHost, ssl: false });
  await expect.poll(() => visit(parentHost), slowPoll).toEqual({ status: 200, body: 'baked-one' });
  const liveParent = await apiGet<Service>(page, `/v1/services/${parent.id}`);
  expect(liveParent.runtimeId).toBeTruthy();

  await page.goto(`/services/${parent.id}?tab=settings`);
  // N10: the switch is named after what it turns on (it used to have no name at all).
  const toggle = page.getByRole('checkbox', { name: 'Ephemeral PR / MR Preview Deployments' });
  await toggle.locator('..').click();
  await expect(toggle).toBeChecked();
  await page.getByRole('button', { name: 'Save PR preview settings' }).click();
  await expect(page.getByText('PR Preview settings saved', { exact: true })).toBeVisible();
  const hook = await post<Hook>(`/v1/services/${parent.id}/webhooks`, {});

  async function deliver<T>(action: 'opened' | 'closed', number: number, branch: Branch) {
    const data = JSON.stringify({
      action, number,
      pull_request: { number, title: `Fixture PR ${number}`, user: { login: 'n08-fixture' }, merged: false,
        head: { ref: branch.name, sha: branch.commit, repo: { clone_url: repoUrl } },
        base: { ref: 'main', repo: { clone_url: repoUrl } } },
    });
    const signature = createHmac('sha256', hook.secret).update(data).digest('hex');
    const response = await page.request.post(`/v1/hooks/${hook.id}`, { data, headers: {
      'content-type': 'application/json',
      'x-github-event': 'pull_request',
      'x-github-delivery': randomUUID(),
      'x-hub-signature-256': `sha256=${signature}`,
    } });
    expect(response.ok(), `PR ${number} ${action}: HTTP ${response.status()}`).toBe(true);
    return await response.json() as T;
  }

  const beforePreview = gitRequests();
  const opened = await deliver<Opened>('opened', 81, git.preview);
  expect(opened.action).toBe('preview_deployment_queued');
  await expect.poll(async () => (await deployments(page, opened.previewServiceId))[0], slowPoll)
    .toMatchObject({ id: opened.deploymentId, status: 'running', commitSha: git.preview.commit });
  expect(gitRequests()).toBeGreaterThan(beforePreview);
  const preview = await apiGet<Service>(page, `/v1/services/${opened.previewServiceId}`);
  expect(preview.previewParentServiceId).toBe(parent.id);
  expect(preview.runtimeId).toBeTruthy();
  await page.goto('/services');
  await page.getByText(preview.name, { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/services/${preview.id}$`));
  const previewHost = `pr-81-${parent.slug}.n08.test`;
  await expect.poll(() => visit(previewHost), slowPoll).toEqual({ status: 200, body: 'n08-preview-content' });
  const runtimeId = inner(['inspect', preview.runtimeId!, '--format', '{{.Id}}']);
  const bridgeId = inner(['network', 'inspect', `nd-svc-${preview.slug}`, '--format', '{{.Id}}']);
  expect(runtimeId).toMatch(/^[0-9a-f]{64}$/);
  expect(bridgeId).toMatch(/^[0-9a-f]{64}$/);

  const failed = await deliver<Opened>('opened', 82, git.broken);
  expect(failed.action).toBe('preview_deployment_queued');
  await expect.poll(async () => (await deployments(page, failed.previewServiceId))[0], slowPoll)
    .toMatchObject({ id: failed.deploymentId, status: 'failed', commitSha: git.broken.commit });
  const broken = await apiGet<Service>(page, `/v1/services/${failed.previewServiceId}`);
  const brokenHost = `pr-82-${parent.slug}.n08.test`;
  expect(broken.runtimeId).toBeNull();
  await page.goto(`/services/${broken.id}?tab=deploys`);
  await expect(page.getByText('Failed', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Deployment output', { exact: true })).toBeVisible();
  await expect(page.getByText(/N08_EXPECTED_BUILD_FAILURE/).first()).toBeVisible();
  expect(visit(previewHost)).toEqual({ status: 200, body: 'n08-preview-content' });

  for (const [child, number, branch] of [[preview, 81, git.preview], [broken, 82, git.broken]] as const) {
    expect(await deliver('closed', number, branch))
      .toMatchObject({ action: 'preview_destroyed', serviceId: child.id });
    const response = await page.request.get(`/v1/services/${child.id}`, { headers: authorization });
    expect(response.status()).toBe(404);
  }
  await expect.poll(() => visit(previewHost).status, slowPoll).toBe(404);
  await expect.poll(() => visit(brokenHost).status, slowPoll).toBe(404);
  expect(inner(['ps', '-aq', '--filter', `id=${runtimeId}`])).toBe('');
  expect(inner(['network', 'ls', '-q', '--filter', `id=${bridgeId}`])).toBe('');
  expect(inner(['network', 'ls', '-q', '--filter', `name=^nd-svc-${broken.slug}$`])).toBe('');
  expect(visit(parentHost)).toEqual({ status: 200, body: 'baked-one' });
  expect((await apiGet<Service>(page, `/v1/services/${parent.id}`)).runtimeId).toBe(liveParent.runtimeId);
  await page.goto('/services');
  const card = (id: number) => page.locator(`main a[href="/services/${id}"]`);
  await expect(card(parent.id)).toBeVisible();
  await expect(card(preview.id)).toHaveCount(0);
  await expect(card(broken.id)).toHaveCount(0);
  w.assertClean();
});
