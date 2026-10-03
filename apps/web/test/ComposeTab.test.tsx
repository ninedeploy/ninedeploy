import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../src/components/Toast.js';

const apiMock = vi.hoisted(() => ({
  api: {
    services: { update: vi.fn() },
    deploys: { trigger: vi.fn() },
  },
}));
vi.mock('../src/lib/api.js', () => apiMock);

import { ComposeTab } from '../src/routes/service/ComposeTab.js';

const STACK = 'services:\n  web:\n    image: nginx:alpine\n';
/** A newer revision, as another session (or a redeploy refetch) would deliver it. */
const NEXT_STACK = 'services:\n  web:\n    image: nginx:1.27\n';

// Only the fields the tab reads; the full Service shape is not the subject here.
const service: any = {
  id: 4,
  name: 'Stack',
  slug: 'stack',
  type: 'compose',
  status: 'running',
  composeService: 'web',
  composeContent: STACK,
};

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}{location.search}</div>;
}

/** The tab in its real surroundings. Reused by `update` so a changed prop
 *  re-renders the mounted component instead of remounting a fresh one — the
 *  difference between testing the effect and testing `useState`'s initializer. */
function tree(over: Record<string, unknown>, client: QueryClient) {
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/services/4']}>
        <ToastProvider>
          <ComposeTab service={{ ...service, ...over }} />
          <Routes>
            <Route path="*" element={<LocationProbe />} />
          </Routes>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function renderTab(over: Record<string, unknown> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(tree(over, client));
  return { ...utils, update: (next: Record<string, unknown>) => utils.rerender(tree(next, client)) };
}

const editor = () => screen.getByLabelText('Compose file editor');

describe('ComposeTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.api.services.update.mockResolvedValue({ ...service });
    apiMock.api.deploys.trigger.mockResolvedValue({ deploymentId: 11 });
  });

  it('shows the stored YAML and where it runs', () => {
    renderTab();
    expect(editor()).toHaveValue(STACK);
    expect(screen.getByText('ndcmp-stack')).toBeInTheDocument();
    expect(screen.getByText('web')).toBeInTheDocument();
  });

  it('keeps both save buttons disabled until the file actually changes', async () => {
    renderTab();
    expect(screen.getByRole('button', { name: /^Save$/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Save & redeploy/ })).toBeDisabled();

    fireEvent.change(editor(), { target: { value: `${STACK}  cache:\n    image: redis:7\n` } });
    await waitFor(() => expect(screen.getByRole('button', { name: /^Save$/ })).toBeEnabled());
  });

  it('saves without deploying, and says the change is not live yet', async () => {
    renderTab();
    const next = 'services:\n  web:\n    image: nginx:1.27\n';
    fireEvent.change(editor(), { target: { value: next } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));

    await waitFor(() => expect(apiMock.api.services.update).toHaveBeenCalledWith(4, { composeContent: next }));
    expect(apiMock.api.deploys.trigger).not.toHaveBeenCalled();
    expect(await screen.findByText(/redeploy to apply/i)).toBeInTheDocument();
  });

  it('saves and redeploys, then follows the deployment', async () => {
    renderTab();
    const next = 'services:\n  web:\n    image: nginx:1.27\n';
    fireEvent.change(editor(), { target: { value: next } });
    fireEvent.click(screen.getByRole('button', { name: /Save & redeploy/ }));

    await waitFor(() => expect(apiMock.api.services.update).toHaveBeenCalledWith(4, { composeContent: next }));
    await waitFor(() => expect(apiMock.api.deploys.trigger).toHaveBeenCalledWith(4));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/services/4?tab=deploys'));
  });

  it('r211: refreshes the deploy list so the queued redeploy shows up', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spy = vi.spyOn(client, 'invalidateQueries');
    render(tree({}, client));
    fireEvent.change(editor(), { target: { value: 'services:\n  web:\n    image: nginx:1.28\n' } });
    fireEvent.click(screen.getByRole('button', { name: /Save & redeploy/ }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ queryKey: ['deploys', 4] }));
  });

  it('omits the routed-service line when the stack has no main service yet', () => {
    renderTab({ composeService: null });
    expect(screen.getByText('ndcmp-stack')).toBeInTheDocument();
    expect(screen.queryByText(/routed service/)).not.toBeInTheDocument();
  });

  it('picks up a newer server copy while the editor is untouched', async () => {
    const { update } = renderTab();
    update({ composeContent: NEXT_STACK });
    await waitFor(() => expect(editor()).toHaveValue(NEXT_STACK));
  });

  it('keeps an in-progress edit when the server copy changes underneath', async () => {
    // The detail query refetches every few seconds while a deploy runs —
    // adopting the server copy mid-edit would eat what the user is typing.
    const mine = 'services:\n  web:\n    image: caddy\n';
    const { update } = renderTab();
    fireEvent.change(editor(), { target: { value: mine } });
    update({ composeContent: NEXT_STACK });
    await waitFor(() => expect(editor()).toHaveValue(mine));
  });

  it('reports the server’s reason when the file is refused', async () => {
    // The route re-runs the same preflight as the wizard; a rejected edit must
    // say why instead of silently leaving the old file in place.
    apiMock.api.services.update.mockRejectedValue(
      new Error('Compose file cannot run here: env_file is not supported'),
    );
    renderTab();
    fireEvent.change(editor(), { target: { value: 'services:\n  web:\n    env_file: .env\n' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));

    expect(await screen.findByText(/env_file is not supported/)).toBeInTheDocument();
    expect(apiMock.api.deploys.trigger).not.toHaveBeenCalled();
  });
});
