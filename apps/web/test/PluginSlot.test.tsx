import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({ api: { menus: { list: vi.fn() } } }));
vi.mock('../src/lib/api.js', () => apiMock);

import { PluginSlot } from '../src/components/PluginSlot.js';
import { menuTarget } from '../src/lib/pluginMenus.js';

function renderSlots(...slots: string[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        {slots.map((slot) => (
          <PluginSlot key={slot} slot={slot} />
        ))}
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const item = (over: Record<string, unknown>) => ({ id: String(over.label), slot: 'database:tabs', route: '/x', ...over });

describe('PluginSlot (r566)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shares ONE menus fetch across every slot on the page and filters per slot', async () => {
    apiMock.api.menus.list.mockResolvedValue({
      items: [
        item({ label: 'Db tool', slot: 'database:tabs', description: 'Inspect', badge: { text: 'beta' } }),
        item({ label: 'Svc tool', slot: 'service:tabs', badge: 'new' }),
        item({ label: 'Palette only', slot: 'command:palette' }),
      ],
    });
    renderSlots('database:tabs', 'service:tabs', 'monitoring:widgets');
    expect(await screen.findByText('Db tool')).toBeInTheDocument();
    expect(screen.getByText('Svc tool')).toBeInTheDocument();
    expect(screen.getByText('beta')).toBeInTheDocument();
    expect(screen.getByText('new')).toBeInTheDocument();
    expect(screen.getByText('Inspect')).toBeInTheDocument();
    expect(screen.queryByText('Palette only')).toBeNull();
    // Three slots, one request (it used to be one per slot).
    expect(apiMock.api.menus.list).toHaveBeenCalledTimes(1);
  });

  it('links only http(s) URLs (noopener) and same-origin paths; unsafe routes render no link', async () => {
    apiMock.api.menus.list.mockResolvedValue({
      items: [
        item({ label: 'Internal', route: '/plugins/x' }),
        item({ label: 'External', route: 'https://docs.example.com/p' }),
        item({ label: 'Script', route: 'javascript:alert(1)' }),
        item({ label: 'Data', route: 'data:text/html,<script>1</script>' }),
        item({ label: 'ProtoRel', route: '//evil.example' }),
        item({ label: 'Backslash', route: '/\\evil.example' }),
      ],
    });
    renderSlots('database:tabs');
    await screen.findByText('Internal');
    expect(screen.getByRole('link', { name: 'View' })).toHaveAttribute('href', '/plugins/x');
    const external = screen.getByRole('link', { name: /Open/ });
    expect(external).toHaveAttribute('href', 'https://docs.example.com/p');
    expect(external.getAttribute('rel')).toContain('noopener');
    // Six cards, exactly two links.
    expect(screen.getByText('Script')).toBeInTheDocument();
    expect(screen.getAllByRole('link')).toHaveLength(2);
  });

  it('renders nothing when the menus load fails', async () => {
    apiMock.api.menus.list.mockRejectedValue(new Error('down'));
    const { container } = renderSlots('database:tabs');
    await waitFor(() => expect(apiMock.api.menus.list).toHaveBeenCalled());
    expect(container.querySelector('.plugin-slot')).toBeNull();
  });

  it('accepts the bare-array response older servers sent', async () => {
    apiMock.api.menus.list.mockResolvedValue([item({ label: 'Legacy' })]);
    renderSlots('database:tabs');
    expect(await screen.findByText('Legacy')).toBeInTheDocument();
  });
});

describe('menuTarget (r566)', () => {
  it.each([
    ['/plugins/a?b=1', { kind: 'internal', to: '/plugins/a?b=1' }],
    ['https://example.com/x', { kind: 'external', href: 'https://example.com/x' }],
    ['HTTP://example.com', { kind: 'external', href: 'http://example.com/' }],
  ])('allows %s', (route, expected) => {
    expect(menuTarget(route)).toEqual(expected);
  });

  it.each([
    'javascript:alert(1)',
    ' JavaScript:alert(1)',
    'data:text/html,x',
    'vbscript:x',
    '//evil.example',
    '/\\evil.example',
    '/a\nb',
    'relative/path',
    'https://',
    '',
    undefined,
    42,
  ])('refuses %s', (route) => {
    expect(menuTarget(route)).toBeNull();
  });
});
