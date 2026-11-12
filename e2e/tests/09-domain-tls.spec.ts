import type { Page } from '@playwright/test';
import { expect, perLayout, test } from './fixtures';
import { apiGet, watch } from './support';

/**
 * S7: a domain and its TLS setting, as the panel shows them and as Traefik was
 * given them (router and upstream), without a real certificate: the e2e panel
 * has no ACME account and the name is under .test, so no issuance is attempted
 * here, only the router state.
 */
type Domain = { id: number; hostname: string; ssl: boolean; status: string };
type HttpRoute = { domainId: number; hostname: string; path: string | null; ssl: boolean; router: string | null; upstreams: string[]; verdict: string };

async function serviceId(page: Page, name: string): Promise<number> {
  const list = await apiGet<Array<{ id: number; name: string }> | { items: Array<{ id: number; name: string }> }>(page, '/v1/services');
  const svc = (Array.isArray(list) ? list : list.items).find((s) => s.name === name);
  expect(svc, `service ${name}`).toBeTruthy();
  return svc!.id;
}

const domainOf = async (page: Page, id: number, host: string) => (await apiGet<Domain[]>(page, `/v1/services/${id}/domains`)).find((d) => d.hostname === host);
const routeOf = async (page: Page, id: number, host: string) => (await apiGet<{ http: HttpRoute[] }>(page, `/v1/services/${id}/routing`)).http.find((r) => r.hostname === host);

test('domain and TLS: a domain added in the panel gets a Traefik router to the running container, HTTPS can be switched off and on, and removing it removes the router', async ({ page, layout }) => {
  test.setTimeout(300_000);
  const w = watch(page);
  await page.goto('/');
  const id = await serviceId(page, 'e2e-web');
  const host = `${perLayout(layout, 'shop')}.e2e.test`;

  // Domains: add the host through the form.
  await page.goto(`/services/${id}?tab=network`);
  await page.getByRole('textbox', { name: 'Domain', exact: true }).fill(host);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText(host, { exact: true }).first()).toBeVisible();
  const added = await domainOf(page, id, host);
  expect(added, 'the domain row').toBeTruthy();
  expect(added!.status, 'an operator adds an active domain').toBe('active');

  // Router state: Traefik has a router for the host, pointing at the running container.
  await expect.poll(async () => {
    const r = await routeOf(page, id, host);
    return r ? `${r.verdict}|${r.router ? 'router' : 'none'}|${r.upstreams.length}` : 'missing';
  }, { timeout: 90_000, intervals: [2_000, 5_000] }).toBe('ok|router|1');
  const route = (await routeOf(page, id, host))!;
  // A new domain starts with HTTPS on; the routing view shows the scheme Traefik serves.
  expect(route.ssl, 'the route follows the domain').toBe(added!.ssl);
  const scheme = (ssl: boolean) => (ssl ? 'https' : 'http');
  await page.getByRole('button', { name: 'Refresh routing' }).click();
  await expect(page.getByText(`${scheme(route.ssl)}://${host}${route.path ?? ''}`, { exact: true })).toBeVisible();
  await expect(page.getByText(route.router!, { exact: true })).toBeVisible();

  // HTTPS switched from the domain row, then back: the domain and its router follow each time.
  for (const want of [!added!.ssl, added!.ssl]) {
    await page.getByTitle(want ? 'HTTPS off — click to issue a certificate' : 'HTTPS on — click to disable').click();
    await expect.poll(async () => (await domainOf(page, id, host))?.ssl, { timeout: 30_000 }).toBe(want);
    await expect.poll(async () => {
      const r = await routeOf(page, id, host);
      return r ? `${r.ssl}|${r.router ? 'router' : 'none'}` : 'missing';
    }, { timeout: 90_000, intervals: [2_000, 5_000] }).toBe(`${want}|router`);
    await page.getByRole('button', { name: 'Refresh routing' }).click();
    await expect(page.getByText(`${scheme(want)}://${host}${route.path ?? ''}`, { exact: true })).toBeVisible();
  }

  // Removed: the row and the router go.
  await page.getByRole('button', { name: `Remove ${host}` }).click();
  const confirm = page.getByRole('dialog').getByRole('button', { name: /^(Remove|Delete)$/ });
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
  await expect.poll(async () => (await domainOf(page, id, host)) ?? null, { timeout: 30_000 }).toBeNull();
  await expect.poll(async () => (await routeOf(page, id, host)) ?? null, { timeout: 60_000 }).toBeNull();
  w.assertClean();
});
