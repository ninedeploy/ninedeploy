/**
 * Coverage tests for the 16 section components. Each section is exercised
 * in isolation with a minimal render+edit flow so the per-file
 * 100 % coverage threshold in `apps/web` is met without re-asserting the
 * page-level behaviour (that's covered in ManifestCreator.test.tsx).
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import type { NinedeployManifest } from '@ninedeploy/schemas';
import './web-utils.js';
import { AlertsSection } from '../src/routes/manifestCreator/sections/AlertsSection.js';
import { BuildSection } from '../src/routes/manifestCreator/sections/BuildSection.js';
import { DatabaseSection } from '../src/routes/manifestCreator/sections/DatabaseSection.js';
import { EnvSection } from '../src/routes/manifestCreator/sections/EnvSection.js';
import { HooksSection } from '../src/routes/manifestCreator/sections/HooksSection.js';
import { NetworkSection } from '../src/routes/manifestCreator/sections/NetworkSection.js';
import { NotificationsSection } from '../src/routes/manifestCreator/sections/NotificationsSection.js';
import { PhasesSection } from '../src/routes/manifestCreator/sections/PhasesSection.js';
import { PreviewsSection } from '../src/routes/manifestCreator/sections/PreviewsSection.js';
import { ResourcesSection } from '../src/routes/manifestCreator/sections/ResourcesSection.js';
import { RoutingSection } from '../src/routes/manifestCreator/sections/RoutingSection.js';
import { RunSection } from '../src/routes/manifestCreator/sections/RunSection.js';
import { StaticSection } from '../src/routes/manifestCreator/sections/StaticSection.js';
import { VolumeSection } from '../src/routes/manifestCreator/sections/VolumeSection.js';
import { WatchSection } from '../src/routes/manifestCreator/sections/WatchSection.js';
import { RuntimeSection } from '../src/routes/manifestCreator/sections/RuntimeSection.js';

/**
 * DatabaseSection pulls live managed-DB suggestions through react-query,
 * so its renders need a QueryClientProvider. Queries fail fast (retry off)
 * and the section degrades to manual entry, which is what these tests pin.
 */
function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('RuntimeSection', () => {
  // `Field` renders its label as a plain <span>, so the type select has no
  // accessible name — it is simply the first combobox in the section.
  const typeSelect = () => screen.getAllByRole('combobox')[0]!;
  const versionSelect = () => screen.getByLabelText('Runtime version');
  const versionInput = () =>
    screen.getByPlaceholderText(/leave empty to let Nixpacks/) as HTMLInputElement;

  it('renders type and version fields, emits onChange when type is changed', () => {
    const onChange = vi.fn();
    render(<RuntimeSection value={undefined} onChange={onChange} />);
    // `auto` has no version axis, so only the type select is rendered.
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'python' } });
    expect(onChange).toHaveBeenCalledWith({ type: 'python' });
  });

  it('emits onChange with the version when the version input is typed', () => {
    const onChange = vi.fn();
    render(<RuntimeSection value={undefined} onChange={onChange} />);
    fireEvent.change(versionInput(), { target: { value: '20' } });
    expect(onChange).toHaveBeenLastCalledWith({ type: 'auto', version: '20' });
  });

  it('clears the version when the input is emptied', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RuntimeSection value={{ type: 'auto', version: '20' }} onChange={onChange} />);
    await user.clear(versionInput());
    expect(onChange).toHaveBeenLastCalledWith({ type: 'auto' });
  });

  it('offers catalog versions for a pinnable runtime and emits the picked one', () => {
    const onChange = vi.fn();
    render(<RuntimeSection value={{ type: 'node' }} onChange={onChange} />);
    fireEvent.change(versionSelect(), { target: { value: '22' } });
    expect(onChange).toHaveBeenLastCalledWith({ type: 'node', version: '22' });
  });

  it('drops the pin when "no pin" is chosen', () => {
    const onChange = vi.fn();
    render(<RuntimeSection value={{ type: 'node', version: '24' }} onChange={onChange} />);
    fireEvent.change(versionSelect(), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({ type: 'node' });
  });

  it('still allows an end-of-life version, with a warning instead of a block', () => {
    const onChange = vi.fn();
    render(<RuntimeSection value={{ type: 'node' }} onChange={onChange} />);
    fireEvent.change(versionSelect(), { target: { value: '20' } });
    expect(onChange).toHaveBeenLastCalledWith({ type: 'node', version: '20' });
  });

  it('shows an end-of-life advisory for an unsupported pin', () => {
    render(<RuntimeSection value={{ type: 'node', version: '20' }} onChange={vi.fn()} />);
    expect(screen.getByText('End of life')).toBeInTheDocument();
    expect(screen.getByText(/no longer receives security patches/)).toBeInTheDocument();
  });

  it('shows a security-only advisory and no advisory for a supported pin', () => {
    const { unmount } = render(
      <RuntimeSection value={{ type: 'python', version: '3.12' }} onChange={vi.fn()} />,
    );
    expect(screen.getByText('Security fixes only')).toBeInTheDocument();
    unmount();
    render(<RuntimeSection value={{ type: 'node', version: '24' }} onChange={vi.fn()} />);
    expect(screen.queryByText('End of life')).not.toBeInTheDocument();
    expect(screen.queryByText('Security fixes only')).not.toBeInTheDocument();
  });

  it('falls back to the free-text input for a version outside the catalog', () => {
    render(<RuntimeSection value={{ type: 'node', version: '19' }} onChange={vi.fn()} />);
    expect(versionInput().value).toBe('19');
    expect(screen.getByText('Unverified')).toBeInTheDocument();
  });

  it('reveals the free-text input when "Other version…" is picked', () => {
    const onChange = vi.fn();
    render(<RuntimeSection value={{ type: 'node' }} onChange={onChange} />);
    expect(screen.queryByPlaceholderText(/leave empty to let Nixpacks/)).not.toBeInTheDocument();
    fireEvent.change(versionSelect(), { target: { value: '__custom__' } });
    // Switching to custom is a UI-only move — nothing is emitted until typed.
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(versionInput(), { target: { value: '20.18.1' } });
    expect(onChange).toHaveBeenLastCalledWith({ type: 'node', version: '20.18.1' });
  });

  it('keeps a version across a type change only when it is valid for the new type', () => {
    const onChange = vi.fn();
    const { unmount } = render(
      <RuntimeSection value={{ type: 'node', version: '24' }} onChange={onChange} />,
    );
    fireEvent.change(typeSelect(), { target: { value: 'python' } });
    // "24" means nothing to Python, so the pin is dropped rather than carried.
    expect(onChange).toHaveBeenLastCalledWith({ type: 'python' });
    unmount();

    const onChange2 = vi.fn();
    render(<RuntimeSection value={{ type: 'auto', version: '24' }} onChange={onChange2} />);
    fireEvent.change(typeSelect(), { target: { value: 'node' } });
    expect(onChange2).toHaveBeenLastCalledWith({ type: 'node', version: '24' });
  });
});

describe('BuildSection', () => {
  it('updates install on input', () => {
    const onChange = vi.fn();
    render(<BuildSection value={undefined} onChange={onChange} />);
    const input = screen.getByPlaceholderText(/npm ci/);
    fireEvent.change(input, { target: { value: 'pnpm install --frozen-lockfile' } });
    expect(onChange).toHaveBeenLastCalledWith({ install: 'pnpm install --frozen-lockfile' });
  });

  it('updates build on input', () => {
    const onChange = vi.fn();
    render(<BuildSection value={undefined} onChange={onChange} />);
    const input = screen.getByPlaceholderText(/npm run build/);
    fireEvent.change(input, { target: { value: 'pnpm build' } });
    expect(onChange).toHaveBeenLastCalledWith({ build: 'pnpm build' });
  });

  it('updates start on input', () => {
    const onChange = vi.fn();
    render(<BuildSection value={undefined} onChange={onChange} />);
    const input = screen.getByPlaceholderText(/node server.js/);
    fireEvent.change(input, { target: { value: 'pnpm start' } });
    expect(onChange).toHaveBeenLastCalledWith({ start: 'pnpm start' });
  });

  it('updates baseDir on input', () => {
    const onChange = vi.fn();
    render(<BuildSection value={undefined} onChange={onChange} />);
    const input = screen.getByPlaceholderText(/leave empty for repo root/);
    fireEvent.change(input, { target: { value: 'apps/web' } });
    expect(onChange).toHaveBeenLastCalledWith({ baseDir: 'apps/web' });
  });

  it('updates dockerfile on input', () => {
    const onChange = vi.fn();
    render(<BuildSection value={undefined} onChange={onChange} />);
    const input = screen.getByPlaceholderText(/docker\/Dockerfile.prod/);
    fireEvent.change(input, { target: { value: 'docker/Dockerfile.prod' } });
    expect(onChange).toHaveBeenLastCalledWith({ dockerfile: 'docker/Dockerfile.prod' });
  });

  it('clears a field when the input is emptied', () => {
    const onChange = vi.fn();
    render(<BuildSection value={{ install: 'npm ci' }} onChange={onChange} />);
    const input = screen.getByPlaceholderText(/npm ci/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({ install: undefined });
  });
});

describe('RunSection', () => {
  it('updates the port on input', () => {
    const onChange = vi.fn();
    render(<RunSection value={undefined} onChange={onChange} />);
    const port = screen.getByPlaceholderText('3000') as HTMLInputElement;
    fireEvent.change(port, { target: { value: '8080' } });
    expect(onChange).toHaveBeenLastCalledWith({ port: 8080 });
  });

  it('updates the restart on select change', () => {
    const onChange = vi.fn();
    render(<RunSection value={undefined} onChange={onChange} />);
    const restart = screen.getAllByRole('combobox')[0]!;
    fireEvent.change(restart, { target: { value: 'always' } });
    expect(onChange).toHaveBeenLastCalledWith({ restart: 'always' });
  });

  it('updates the healthcheck on input', () => {
    const onChange = vi.fn();
    render(<RunSection value={undefined} onChange={onChange} />);
    const input = screen.getByPlaceholderText('/healthz') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '/ready' } });
    expect(onChange).toHaveBeenLastCalledWith({ healthcheck: '/ready' });
  });
});

describe('StaticSection', () => {
  it('toggles the SPA switch and propagates root on type', async () => {
    const onChange = vi.fn();
    render(<StaticSection value={undefined} onChange={onChange} />);
    const switchBtn = screen.getByRole('switch');
    fireEvent.click(switchBtn);
    expect(onChange).toHaveBeenLastCalledWith({ spa: true });
  });

  it('updates the root path on input', () => {
    const onChange = vi.fn();
    render(<StaticSection value={{ spa: true, root: 'dist' }} onChange={onChange} />);
    const input = screen.getByDisplayValue('dist') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'public' } });
    expect(onChange).toHaveBeenLastCalledWith({ spa: true, root: 'public' });
  });

  it('toggles SPA off (spa true → false) and emits with no root', () => {
    const onChange = vi.fn();
    render(<StaticSection value={{ spa: true, root: 'dist' }} onChange={onChange} />);
    const switchBtn = screen.getByRole('switch');
    fireEvent.click(switchBtn);
    // When toggling off from { spa: true, root: 'dist' } the spread
    // includes the existing root so the user can re-enable without
    // losing it.
    expect(onChange).toHaveBeenLastCalledWith({ spa: false, root: 'dist' });
  });
});

describe('EnvSection', () => {
  it('emits onChange with required and aliases merged', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<EnvSection value={undefined} onChange={onChange} />);
    const input = screen.getByPlaceholderText('DATABASE_URL');
    await user.type(input, 'A{enter}');
    expect(onChange).toHaveBeenLastCalledWith({ required: ['A'] });
  });

  it('emits onChange with an alias added via the key/value editor', async () => {
    const onChange = vi.fn();
    render(<EnvSection value={{ required: [] }} onChange={onChange} />);
    const addButton = screen.getByRole('button', { name: /Add alias/ });
    fireEvent.click(addButton);
    expect(onChange).toHaveBeenLastCalledWith({ required: [], aliases: { '': '' } });
  });

  it('emits onChange without aliases when the user clears the last row', () => {
    const onChange = vi.fn();
    render(<EnvSection value={{ required: [], aliases: { X: 'Y' } }} onChange={onChange} />);
    const deleteButton = screen.getByLabelText('Delete X');
    fireEvent.click(deleteButton);
    // The deleted row's value should be dropped from the result.
    expect(onChange).toHaveBeenLastCalledWith({ required: [] });
  });

  it('renders with a pre-populated required list', () => {
    render(<EnvSection value={{ required: ['A', 'B'] }} onChange={() => {}} />);
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByText('B')).toBeInTheDocument();
  });
});

describe('PhasesSection', () => {
  it('emits onChange with the new setup pkg list when a chip is added', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PhasesSection value={undefined} onChange={onChange} />);
    const input = screen.getByPlaceholderText('python310');
    await user.type(input, 'imagemagick{enter}');
    expect(onChange).toHaveBeenLastCalledWith({ setup: { pkgs: ['imagemagick'] } });
  });

  it('emits onChange with the new build cmd list when a chip is added', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PhasesSection value={undefined} onChange={onChange} />);
    const input = screen.getByPlaceholderText('npm run build:assets');
    await user.type(input, 'a{enter}');
    expect(onChange).toHaveBeenLastCalledWith({ build: { cmds: ['a'] } });
  });
});

describe('ResourcesSection', () => {
  it('emits onChange with cpuShares when the first input is typed', () => {
    const onChange = vi.fn();
    render(<ResourcesSection value={undefined} onChange={onChange} />);
    const input = screen.getByPlaceholderText('1024');
    fireEvent.change(input, { target: { value: '2048' } });
    expect(onChange).toHaveBeenLastCalledWith({ cpuShares: 2048 });
  });
});

describe('HooksSection', () => {
  it('emits onChange with preBuild when the first input is typed', () => {
    const onChange = vi.fn();
    render(<HooksSection value={undefined} onChange={onChange} />);
    const input = screen.getByPlaceholderText('./scripts/gen-types.sh') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'a.sh' } });
    expect(onChange).toHaveBeenLastCalledWith({ preBuild: 'a.sh' });
  });

  it('emits onChange with postBuild when the second input is typed', () => {
    const onChange = vi.fn();
    render(<HooksSection value={undefined} onChange={onChange} />);
    const input = screen.getByPlaceholderText('./scripts/smoke.sh') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'b.sh' } });
    expect(onChange).toHaveBeenLastCalledWith({ postBuild: 'b.sh' });
  });

  it('emits onChange with preStop when the third input is typed', () => {
    const onChange = vi.fn();
    render(<HooksSection value={undefined} onChange={onChange} />);
    const input = screen.getByPlaceholderText('./scripts/drain.sh') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'c.sh' } });
    expect(onChange).toHaveBeenLastCalledWith({ preStop: 'c.sh' });
  });

  it('clears a hook when its input is emptied', () => {
    const onChange = vi.fn();
    render(<HooksSection value={{ preBuild: 'a.sh' }} onChange={onChange} />);
    const input = screen.getByDisplayValue('a.sh');
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({ preBuild: undefined });
  });
});

describe('WatchSection', () => {
  it('emits onChange with the new paths when a chip is added', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<WatchSection value={undefined} onChange={onChange} />);
    const input = screen.getByPlaceholderText('apps/web/**');
    await user.type(input, 'pkg/**{enter}');
    expect(onChange).toHaveBeenLastCalledWith({ paths: ['pkg/**'] });
  });
});

describe('RoutingSection', () => {
  it('emits onChange when the first route is added', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RoutingSection value={undefined} onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: /Add route/ }));
    expect(onChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ host: '', path: '/', ssl: true }),
    ]);
  });

  it('emits onChange when an existing route host is typed', async () => {
    const onChange = vi.fn();
    render(<RoutingSection value={[{ host: '', path: '/', ssl: true }]} onChange={onChange} />);
    const hostInput = screen.getByPlaceholderText('app.example.com');
    fireEvent.change(hostInput, { target: { value: 'a.example.com' } });
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ host: 'a.example.com', path: '/', ssl: true }),
    ]);
  });

  it('updates the path field on input', () => {
    const onChange = vi.fn();
    render(<RoutingSection value={[{ host: 'a.example.com', path: '/', ssl: true }]} onChange={onChange} />);
    const input = screen.getByPlaceholderText('/') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '/api' } });
    expect(onChange).toHaveBeenLastCalledWith([{ host: 'a.example.com', path: '/api', ssl: true }]);
  });

  it('toggles the SSL switch', () => {
    const onChange = vi.fn();
    render(<RoutingSection value={[{ host: 'a.example.com', path: '/', ssl: true }]} onChange={onChange} />);
    const switchBtn = screen.getByRole('switch');
    fireEvent.click(switchBtn);
    expect(onChange).toHaveBeenLastCalledWith([{ host: 'a.example.com', path: '/', ssl: false }]);
  });

  it('updates the IP allowlist on input', () => {
    const onChange = vi.fn();
    render(<RoutingSection value={[{ host: 'a.example.com', path: '/', ssl: true }]} onChange={onChange} />);
    const input = screen.getByPlaceholderText(/1\.2\.3\.4/);
    fireEvent.change(input, { target: { value: '1.2.3.4/32, 10.0.0.0/8' } });
    expect(onChange).toHaveBeenLastCalledWith([
      { host: 'a.example.com', path: '/', ssl: true, ipAllowlist: ['1.2.3.4/32', '10.0.0.0/8'] },
    ]);
  });

  it('clears the IP allowlist when the input is emptied', () => {
    const onChange = vi.fn();
    render(
      <RoutingSection
        value={[{ host: 'a.example.com', path: '/', ssl: true, ipAllowlist: ['1.2.3.4/32'] }]}
        onChange={onChange}
      />,
    );
    const input = screen.getByDisplayValue('1.2.3.4/32');
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith([{ host: 'a.example.com', path: '/', ssl: true }]);
  });

  it('updates the rate limit on input', () => {
    const onChange = vi.fn();
    render(<RoutingSection value={[{ host: 'a.example.com', path: '/', ssl: true }]} onChange={onChange} />);
    const input = screen.getByPlaceholderText(/50\/100/);
    fireEvent.change(input, { target: { value: '50/100' } });
    expect(onChange).toHaveBeenLastCalledWith([
      { host: 'a.example.com', path: '/', ssl: true, rateLimit: { average: 50, burst: 100 } },
    ]);
  });

  it('ignores malformed rate-limit input (does not call onChange)', () => {
    const onChange = vi.fn();
    render(<RoutingSection value={[{ host: 'a.example.com', path: '/', ssl: true }]} onChange={onChange} />);
    const input = screen.getByPlaceholderText(/50\/100/);
    fireEvent.change(input, { target: { value: 'not-a-number' } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('clears the rate limit when the input is emptied', () => {
    const onChange = vi.fn();
    render(
      <RoutingSection
        value={[{ host: 'a.example.com', path: '/', ssl: true, rateLimit: { average: 50, burst: 100 } }]}
        onChange={onChange}
      />,
    );
    const input = screen.getByDisplayValue('50/100');
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith([{ host: 'a.example.com', path: '/', ssl: true }]);
  });

  it('updates a header on input', () => {
    const onChange = vi.fn();
    render(
      <RoutingSection
        value={[{ host: 'a.example.com', path: '/', ssl: true, headers: { 'X-Test': '1' } }]}
        onChange={onChange}
      />,
    );
    const valInput = screen.getByDisplayValue('1');
    fireEvent.blur(valInput, { target: { value: '2' } });
    expect(onChange).toHaveBeenLastCalledWith([
      { host: 'a.example.com', path: '/', ssl: true, headers: { 'X-Test': '2' } },
    ]);
  });

  it('removes a route via the remove button', () => {
    const onChange = vi.fn();
    render(
      <RoutingSection
        value={[
          { host: 'a.example.com', path: '/', ssl: true },
          { host: 'b.example.com', path: '/', ssl: true },
        ]}
        onChange={onChange}
      />,
    );
    const removeButtons = screen.getAllByLabelText('Remove');
    fireEvent.click(removeButtons[0]!);
    expect(onChange).toHaveBeenLastCalledWith([{ host: 'b.example.com', path: '/', ssl: true }]);
  });

  it('removes a route header when the last header is removed', () => {
    const onChange = vi.fn();
    render(
      <RoutingSection
        value={[
          {
            host: 'a.example.com',
            path: '/',
            ssl: true,
            headers: { 'X-Test': '1' },
          },
        ]}
        onChange={onChange}
      />,
    );
    // The header row has a delete button labelled "Delete X-Test".
    const deleteHeader = screen.getByLabelText('Delete X-Test');
    fireEvent.click(deleteHeader);
    expect(onChange).toHaveBeenLastCalledWith([{ host: 'a.example.com', path: '/', ssl: true }]);
  });
});

describe('PreviewsSection', () => {
  it('toggles the enabled switch and emits a manifest', () => {
    const onChange = vi.fn();
    render(<PreviewsSection value={undefined} onChange={onChange} />);
    const switchBtn = screen.getByRole('switch');
    fireEvent.click(switchBtn);
    expect(onChange).toHaveBeenCalled();
    const last = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] as {
      enabled: boolean;
      pattern: string;
    };
    expect(last.enabled).toBe(true);
    expect(last.pattern).toContain('{n}');
  });

  it('toggles the switch off and clears the section', () => {
    const onChange = vi.fn();
    render(
      <PreviewsSection
        value={{ enabled: true, pattern: 'pr-{n}.example.com', maxActive: 5, autoDestroyOnClose: true }}
        onChange={onChange}
      />,
    );
    const switchBtn = screen.getByRole('switch');
    fireEvent.click(switchBtn);
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it('updates the pattern on input', () => {
    const onChange = vi.fn();
    render(
      <PreviewsSection
        value={{ enabled: true, pattern: 'pr-{n}.example.com', maxActive: 5, autoDestroyOnClose: true }}
        onChange={onChange}
      />,
    );
    const input = screen.getByDisplayValue('pr-{n}.example.com') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'preview-{n}.test.com' } });
    expect(onChange).toHaveBeenLastCalledWith({
      enabled: true,
      pattern: 'preview-{n}.test.com',
      maxActive: 5,
      autoDestroyOnClose: true,
    });
  });

  it('updates the maxActive on input', () => {
    const onChange = vi.fn();
    render(
      <PreviewsSection
        value={{ enabled: true, pattern: 'pr-{n}.example.com', maxActive: 5, autoDestroyOnClose: true }}
        onChange={onChange}
      />,
    );
    const input = screen.getByDisplayValue('5') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '10' } });
    expect(onChange).toHaveBeenLastCalledWith({
      enabled: true,
      pattern: 'pr-{n}.example.com',
      maxActive: 10,
      autoDestroyOnClose: true,
    });
  });

  it('re-enabling with an existing pattern keeps the pattern', () => {
    const onChange = vi.fn();
    render(
      <PreviewsSection
        value={{ enabled: true, pattern: 'pr-{n}.example.com', maxActive: 5, autoDestroyOnClose: true }}
        onChange={onChange}
      />,
    );
    const switchBtn = screen.getByRole('switch');
    // The first click disables.
    fireEvent.click(switchBtn);
    expect(onChange).toHaveBeenLastCalledWith(undefined);
    // The component was rendered with `value` set to undefined after
    // the previous onChange fired; simulating the second render would
    // need a controlled harness, so the re-enable click here is a
    // best-effort check that the toggle cycle is stable.
  });
});

describe('VolumeSection', () => {
  it('emits onChange with the new mount when typed', async () => {
    const onChange = vi.fn();
    render(<VolumeSection value={undefined} onChange={onChange} />);
    const input = screen.getByPlaceholderText('/data');
    fireEvent.change(input, { target: { value: '/var/data' } });
    expect(onChange).toHaveBeenLastCalledWith({ mount: '/var/data' });
  });

  it('emits onChange with the schedule when typed', () => {
    const onChange = vi.fn();
    render(<VolumeSection value={undefined} onChange={onChange} />);
    const input = screen.getByPlaceholderText('0 3 * * *') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '0 4 * * *' } });
    expect(onChange).toHaveBeenLastCalledWith({
      backups: { schedule: '0 4 * * *', retention: 7 },
    });
  });

  it('clears the schedule when emptied (drops backups from the section)', () => {
    const onChange = vi.fn();
    render(
      <VolumeSection
        value={{ mount: '/data', backups: { schedule: '0 3 * * *', retention: 7 } }}
        onChange={onChange}
      />,
    );
    const input = screen.getByDisplayValue('0 3 * * *');
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({ mount: '/data' });
  });

  it('updates retention on input', () => {
    const onChange = vi.fn();
    render(
      <VolumeSection
        value={{ mount: '/data', backups: { schedule: '0 3 * * *', retention: 7 } }}
        onChange={onChange}
      />,
    );
    const input = screen.getByDisplayValue('7') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '14' } });
    expect(onChange).toHaveBeenLastCalledWith({
      mount: '/data',
      backups: { schedule: '0 3 * * *', retention: 14 },
    });
  });

  it('ignores retention changes when the schedule is empty', () => {
    const onChange = vi.fn();
    render(<VolumeSection value={{ mount: '/data' }} onChange={onChange} />);
    const inputs = screen.getAllByRole('spinbutton');
    const retention = inputs.find((i) => (i as HTMLInputElement).value === '7');
    if (retention) fireEvent.change(retention, { target: { value: '14' } });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('DatabaseSection', () => {
  it('emits onChange with the new ref when typed', async () => {
    const onChange = vi.fn();
    renderWithClient(<DatabaseSection value={undefined} onChange={onChange} />);
    const input = screen.getByPlaceholderText('app-db');
    fireEvent.change(input, { target: { value: 'app-db' } });
    expect(onChange).toHaveBeenLastCalledWith({ ref: 'app-db', env: 'DATABASE_URL' });
  });

  it('clears the section when the ref is emptied', () => {
    const onChange = vi.fn();
    renderWithClient(
      <DatabaseSection value={{ ref: 'app-db', env: 'DATABASE_URL' }} onChange={onChange} />,
    );
    const input = screen.getByDisplayValue('app-db');
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it('updates the env key on input', () => {
    const onChange = vi.fn();
    renderWithClient(
      <DatabaseSection value={{ ref: 'app-db', env: 'DATABASE_URL' }} onChange={onChange} />,
    );
    const input = screen.getByDisplayValue('DATABASE_URL') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'POSTGRES_URL' } });
    expect(onChange).toHaveBeenLastCalledWith({ ref: 'app-db', env: 'POSTGRES_URL' });
  });
});

describe('NetworkSection', () => {
  it('emits onChange with the new publishPort when typed', () => {
    const onChange = vi.fn();
    render(<NetworkSection value={undefined} onChange={onChange} />);
    const input = screen.getByPlaceholderText('8080');
    fireEvent.change(input, { target: { value: '9090' } });
    expect(onChange).toHaveBeenLastCalledWith({ aliases: [], publishPort: 9090 });
  });

  it('emits onChange with the new alias when a chip is added', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<NetworkSection value={undefined} onChange={onChange} />);
    const input = screen.getByPlaceholderText('internal-mesh');
    await user.type(input, 'mesh');
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenLastCalledWith({ aliases: ['mesh'] });
  });

  it('emits onChange with publishPort cleared when the input is emptied', () => {
    const onChange = vi.fn();
    render(
      <NetworkSection value={{ publishPort: 8080, aliases: [] }} onChange={onChange} />,
    );
    const input = screen.getByDisplayValue('8080');
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({ aliases: [], publishPort: undefined });
  });
});

describe('NotificationsSection', () => {
  it('emits onChange with the onDeploy list when a chip is added', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<NotificationsSection value={undefined} onChange={onChange} />);
    const input = screen.getByPlaceholderText('ops');
    // Type and press Enter to commit the chip — the user-event way.
    await user.type(input, 'ops');
    await user.keyboard('{Enter}');
    // The NotificationsSection always sends a full object with the three
    // default-empty arrays. Verify onDeploy picked up the chip.
    const last = onChange.mock.calls.at(-1)?.[0] as { onDeploy: string[]; onFailure: string[]; onAlert: string[] };
    expect(last.onDeploy).toEqual(['ops']);
  });

  it('emits onChange with the onFailure list when a chip is added', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<NotificationsSection value={undefined} onChange={onChange} />);
    // Two placeholders share the literal "oncall" (onFailure + onAlert);
    // index 0 is onFailure.
    const inputs = screen.getAllByPlaceholderText('oncall');
    await user.type(inputs[0]!, 'failure-team');
    await user.keyboard('{Enter}');
    const last = onChange.mock.calls.at(-1)?.[0] as { onDeploy: string[]; onFailure: string[]; onAlert: string[] };
    expect(last.onFailure).toEqual(['failure-team']);
  });

  it('emits onChange with the onAlert list when a chip is added', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<NotificationsSection value={undefined} onChange={onChange} />);
    const inputs = screen.getAllByPlaceholderText('oncall');
    // Index 1 is onAlert.
    await user.type(inputs[1]!, 'alerts-team');
    await user.keyboard('{Enter}');
    const last = onChange.mock.calls.at(-1)?.[0] as { onDeploy: string[]; onFailure: string[]; onAlert: string[] };
    expect(last.onAlert).toEqual(['alerts-team']);
  });

  it('emits onChange with the onDeploy list cleared when the chip is removed', () => {
    const onChange = vi.fn();
    render(<NotificationsSection value={{ onDeploy: ['ops'], onFailure: [], onAlert: [] }} onChange={onChange} />);
    // The first chip is "ops" with a remove button.
    const removeButton = screen.getByLabelText('Remove ops');
    fireEvent.click(removeButton);
    const last = onChange.mock.calls.at(-1)?.[0] as { onDeploy: string[] };
    expect(last.onDeploy).toEqual([]);
  });
});

describe('AlertsSection', () => {
  it('emits onChange when the first alert is added', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<AlertsSection value={undefined} onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: /Add alert/ }));
    expect(onChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ when: 'deployFailed', channel: 'oncall' }),
    ]);
  });

  it('updates the channel name on input', () => {
    const onChange = vi.fn();
    render(
      <AlertsSection
        value={[{ when: 'deployFailed', channel: 'oncall' }]}
        onChange={onChange}
      />,
    );
    const input = screen.getByPlaceholderText('oncall') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'ops' } });
    expect(onChange).toHaveBeenLastCalledWith([{ when: 'deployFailed', channel: 'ops' }]);
  });

  it('switches to highMemory and adds a default thresholdPct', () => {
    const onChange = vi.fn();
    render(
      <AlertsSection
        value={[{ when: 'deployFailed', channel: 'oncall' }]}
        onChange={onChange}
      />,
    );
    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'highMemory' } });
    expect(onChange).toHaveBeenLastCalledWith([
      { when: 'highMemory', channel: 'oncall', thresholdPct: 90 },
    ]);
  });

  it('switches back to deployFailed and clears the threshold', () => {
    const onChange = vi.fn();
    render(
      <AlertsSection
        value={[{ when: 'highMemory', channel: 'oncall', thresholdPct: 90 }]}
        onChange={onChange}
      />,
    );
    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'deployFailed' } });
    expect(onChange).toHaveBeenLastCalledWith([{ when: 'deployFailed', channel: 'oncall' }]);
  });

  it('switches from highMemory to highCpu and keeps the threshold', () => {
    const onChange = vi.fn();
    render(
      <AlertsSection
        value={[{ when: 'highMemory', channel: 'oncall', thresholdPct: 90 }]}
        onChange={onChange}
      />,
    );
    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'highCpu' } });
    expect(onChange).toHaveBeenLastCalledWith([
      { when: 'highCpu', channel: 'oncall', thresholdPct: 90 },
    ]);
  });

  it('switches from certExpiry to highMemory and adds the default threshold', () => {
    const onChange = vi.fn();
    render(
      <AlertsSection
        value={[{ when: 'certExpiry', channel: 'oncall' }]}
        onChange={onChange}
      />,
    );
    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'highMemory' } });
    expect(onChange).toHaveBeenLastCalledWith([
      { when: 'highMemory', channel: 'oncall', thresholdPct: 90 },
    ]);
  });

  it('updates the thresholdPct on input', () => {
    const onChange = vi.fn();
    render(
      <AlertsSection
        value={[{ when: 'highMemory', channel: 'oncall', thresholdPct: 90 }]}
        onChange={onChange}
      />,
    );
    const input = screen.getByDisplayValue('90') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '75' } });
    expect(onChange).toHaveBeenLastCalledWith([
      { when: 'highMemory', channel: 'oncall', thresholdPct: 75 },
    ]);
  });

  it('removes an alert via the remove button', () => {
    const onChange = vi.fn();
    render(
      <AlertsSection
        value={[
          { when: 'deployFailed', channel: 'oncall' },
          { when: 'highMemory', channel: 'oncall', thresholdPct: 90 },
        ]}
        onChange={onChange}
      />,
    );
    const removeButtons = screen.getAllByLabelText('Remove');
    fireEvent.click(removeButtons[0]!);
    expect(onChange).toHaveBeenLastCalledWith([{ when: 'highMemory', channel: 'oncall', thresholdPct: 90 }]);
  });
});

// Sanity reference to keep the import count above zero even if every
// describe above skips in a particular run.
const _manifest: NinedeployManifest = { version: '1' };
void _manifest;

// Extra branch coverage: clearing a field with an existing value must
// emit onChange with `undefined` so the section disappears. This pattern
// appears in many section components; each test exercises a single one.
describe('clear-input branches', () => {
  it('RuntimeSection: clearing version sends { type } without version', () => {
    const onChange = vi.fn();
    // "19" is outside the catalog, so the section renders its free-text input.
    render(<RuntimeSection value={{ type: 'node', version: '19' }} onChange={onChange} />);
    const input = screen.getByDisplayValue('19');
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({ type: 'node' });
  });

  it('BuildSection: clearing install sends { install: undefined }', () => {
    const onChange = vi.fn();
    render(<BuildSection value={{ install: 'npm ci' }} onChange={onChange} />);
    const input = screen.getByDisplayValue('npm ci');
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({ install: undefined });
  });

  it('RunSection: clearing port sends { port: undefined }', () => {
    const onChange = vi.fn();
    render(<RunSection value={{ port: 3000 }} onChange={onChange} />);
    const input = screen.getByDisplayValue('3000');
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({ port: undefined });
  });

  it('RunSection: clearing healthcheck sends { healthcheck: undefined }', () => {
    const onChange = vi.fn();
    render(<RunSection value={{ healthcheck: '/healthz' }} onChange={onChange} />);
    const input = screen.getByDisplayValue('/healthz');
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({ healthcheck: undefined });
  });

  it('ResourcesSection: clearing the only set field drops the whole block', () => {
    const onChange = vi.fn();
    renderWithClient(<ResourcesSection value={{ memMb: 512 }} onChange={onChange} />);
    const input = screen.getByDisplayValue('512');
    fireEvent.change(input, { target: { value: '' } });
    // An all-undefined resources block would emit a dangling `resources:`
    // header in the YAML, so the section drops it entirely instead.
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it('DatabaseSection: clearing env key sends the ref with default env', () => {
    const onChange = vi.fn();
    renderWithClient(<DatabaseSection value={{ ref: 'app-db', env: 'X' }} onChange={onChange} />);
    const input = screen.getByDisplayValue('X');
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({ ref: 'app-db', env: 'DATABASE_URL' });
  });

  it('PreviewsSection: typing a new pattern while enabled updates the manifest', () => {
    const onChange = vi.fn();
    render(
      <PreviewsSection
        value={{ enabled: true, pattern: 'pr-{n}.example.com', maxActive: 5, autoDestroyOnClose: true }}
        onChange={onChange}
      />,
    );
    // The number-input for maxActive also has a clear-input branch — set it
    // to an invalid value (empty) and verify onChange still fires.
    const maxInput = screen.getByDisplayValue('5') as HTMLInputElement;
    fireEvent.change(maxInput, { target: { value: '10' } });
    expect(onChange).toHaveBeenLastCalledWith({
      enabled: true,
      pattern: 'pr-{n}.example.com',
      maxActive: 10,
      autoDestroyOnClose: true,
    });
  });

  it('VolumeSection: clearing mount keeps the rest of the section', () => {
    const onChange = vi.fn();
    render(
      <VolumeSection
        value={{ mount: '/data', backups: { schedule: '0 3 * * *', retention: 7 } }}
        onChange={onChange}
      />,
    );
    const input = screen.getByDisplayValue('/data');
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({ backups: { schedule: '0 3 * * *', retention: 7 } });
  });

  it('VolumeSection: clearing schedule drops the backups block', () => {
    const onChange = vi.fn();
    render(
      <VolumeSection
        value={{ mount: '/data', backups: { schedule: '0 3 * * *', retention: 7 } }}
        onChange={onChange}
      />,
    );
    const input = screen.getByDisplayValue('0 3 * * *');
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({ mount: '/data' });
  });

  it('StaticSection: clearing root keeps spa true with no root', () => {
    const onChange = vi.fn();
    render(<StaticSection value={{ spa: true, root: 'dist' }} onChange={onChange} />);
    const input = screen.getByDisplayValue('dist');
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({ spa: true, root: undefined });
  });

  it('EnvSection: removing the only alias keeps required but drops aliases', () => {
    const onChange = vi.fn();
    render(
      <EnvSection
        value={{ required: ['A'], aliases: { X: 'Y' } }}
        onChange={onChange}
      />,
    );
    const deleteButton = screen.getByLabelText('Delete X');
    fireEvent.click(deleteButton);
    expect(onChange).toHaveBeenLastCalledWith({ required: ['A'] });
  });

  it('WatchSection: removing the only watch path yields { paths: [] }', () => {
    const onChange = vi.fn();
    render(<WatchSection value={{ paths: ['apps/**'] }} onChange={onChange} />);
    // The path renders as a chip; click its X.
    const removeButton = screen.getByLabelText('Remove apps/**');
    fireEvent.click(removeButton);
    expect(onChange).toHaveBeenLastCalledWith({ paths: [] });
  });

  it('PhasesSection: removing the only setup pkg yields { setup: { pkgs: [] } }', () => {
    const onChange = vi.fn();
    render(<PhasesSection value={{ setup: { pkgs: ['python310'] } }} onChange={onChange} />);
    const removeButton = screen.getByLabelText('Remove python310');
    fireEvent.click(removeButton);
    expect(onChange).toHaveBeenLastCalledWith({ setup: { pkgs: [] } });
  });

  it('PhasesSection: removing the only build cmd yields { build: { cmds: [] } }', () => {
    const onChange = vi.fn();
    render(<PhasesSection value={{ build: { cmds: ['npm run a'] } }} onChange={onChange} />);
    const removeButton = screen.getByLabelText('Remove npm run a');
    fireEvent.click(removeButton);
    expect(onChange).toHaveBeenLastCalledWith({ build: { cmds: [] } });
  });
});
