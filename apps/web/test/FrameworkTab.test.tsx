import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { FrameworkTab } from '../src/routes/service/FrameworkTab.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

const toastSpy = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../src/components/Toast.js', () => ({
  ToastProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
  useToast: () => toastSpy,
}));

function svc(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    projectIds: [],
    workspaceIds: [],
    labelIds: [],
    name: 'web',
    slug: 'web',
    type: 'docker',
    status: 'running',
    repoUrl: 'https://github.com/x/y',
    branch: 'main',
    sourceId: null,
    image: null,
    volumeMount: null,
    composeService: null,
    commitSha: null,
    runtimeId: null,
    healthPath: '/',
    autoUrl: 'web.nd.local',
    port: 3000,
    publishedPort: null,
    cpuShares: 0,
    memLimitMb: 0,
    build: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  } as never;
}

/** Rich analysis: everything populated (scripts, files, monorepo packages, notes). */
const richInsights = {
  framework: {
    id: 'next',
    name: 'Next.js',
    emoji: '▲',
    category: 'ssr',
    port: 3000,
    installCmd: 'pnpm install',
    buildCmd: 'pnpm build',
    startCmd: 'pnpm start',
    env: [
      { key: 'NODE_ENV', value: 'production', description: 'runtime mode' },
      { key: 'PORT', value: '3000' },
    ],
    notes: ['Uses standalone output'],
  },
  language: 'TypeScript',
  packageManager: 'pnpm',
  nodeVersion: '22',
  frameworkVersion: '15.1.0',
  scripts: { build: 'next build', start: 'next start' },
  dependencyCount: 42,
  devDependencyCount: 7,
  hasDockerfile: false,
  hasComposeFile: false,
  monorepo: true,
  detectedFiles: ['package.json', 'next.config.js'],
  workspacePackages: [
    { dir: 'apps/web', name: 'web', framework: 'Next.js', frameworkVersion: '15.1.0' },
    { dir: 'packages/ui', name: '@acme/ui', framework: null, frameworkVersion: null },
  ],
  baseDir: '/',
  commitSha: 'abcdef1234567890abcdef',
  analyzedAt: '2026-01-02T03:04:05Z',
} as never;

/** Sparse analysis: every optional field empty/null (the "unknown" fallbacks). */
const sparseInsights = {
  framework: {
    id: 'static',
    name: 'Static Site',
    emoji: '📄',
    category: 'static',
    port: 80,
    installCmd: null,
    buildCmd: null,
    startCmd: null,
    env: [],
    notes: [],
  },
  language: 'HTML',
  packageManager: null,
  nodeVersion: null,
  frameworkVersion: null,
  scripts: {},
  dependencyCount: 0,
  devDependencyCount: 0,
  hasDockerfile: false,
  hasComposeFile: false,
  monorepo: false,
  detectedFiles: [],
  workspacePackages: [],
  baseDir: '/',
  commitSha: null,
  analyzedAt: '2026-01-02T03:04:05Z',
} as never;

describe('FrameworkTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    toastSpy.toast.mockClear();
  });

  it('renders the empty state for image services without a repository', () => {
    renderWithProviders(<FrameworkTab serviceId={1} svc={svc({ repoUrl: null })} />);
    expect(screen.getByText('No repository attached')).toBeInTheDocument();
    expect(
      screen.getByText('This service deploys a prebuilt image, so there is no repository to analyze.'),
    ).toBeInTheDocument();
  });

  it('renders a skeleton while the analysis loads', () => {
    mockOf(api.insights.get).mockReturnValue(new Promise(() => {}) as never);
    renderWithProviders(<FrameworkTab serviceId={1} svc={svc()} />);
    expect(document.querySelector('.animate-pulse')).not.toBeNull();
  });

  it('shows the not-analyzed state, runs the analysis and surfaces the result', async () => {
    mockOf(api.insights.get).mockResolvedValue(null as never);
    mockOf(api.insights.refresh).mockResolvedValue(richInsights);
    renderWithProviders(<FrameworkTab serviceId={1} svc={svc()} />);

    expect(await screen.findByText('This repository has not been analyzed yet')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Analyze repository' }));
    await waitFor(() => expect(api.insights.refresh).toHaveBeenCalledWith(1));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Repository analysis updated', 'success'));
    // The refreshed analysis lands in the cache and renders.
    expect(await screen.findByText('What this repository contains')).toBeInTheDocument();
  });

  it('reports the analysis error message and a generic fallback', async () => {
    mockOf(api.insights.get).mockResolvedValue(null as never);
    mockOf(api.insights.refresh).mockRejectedValueOnce(new Error('repo unreachable') as never);
    renderWithProviders(<FrameworkTab serviceId={1} svc={svc()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Analyze repository' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('repo unreachable', 'error'));

    // A non-Error rejection falls back to the generic message.
    mockOf(api.insights.refresh).mockRejectedValueOnce('boom' as never);
    fireEvent.click(screen.getByRole('button', { name: 'Analyze repository' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Analysis failed', 'error'));
  });

  it('shows the analyzing pending label while a refresh is in flight', async () => {
    mockOf(api.insights.get).mockResolvedValue(null as never);
    mockOf(api.insights.refresh).mockReturnValue(new Promise(() => {}) as never);
    renderWithProviders(<FrameworkTab serviceId={1} svc={svc()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Analyze repository' }));
    expect(await screen.findByText('Analyzing…')).toBeInTheDocument();
  });

  it('renders the full analysis: facts, scripts, detected files, monorepo packages and notes', async () => {
    mockOf(api.insights.get).mockResolvedValue(richInsights);
    renderWithProviders(<FrameworkTab serviceId={1} svc={svc()} />);

    expect(await screen.findByText('What this repository contains')).toBeInTheDocument();
    // facts
    expect(screen.getByText('TypeScript')).toBeInTheDocument();
    expect(screen.getAllByText('Next.js').length).toBeGreaterThan(0);
    expect(screen.getAllByText('pnpm').length).toBeGreaterThan(0);
    expect(screen.getByText('42 prod · 7 dev')).toBeInTheDocument();
    expect(screen.getByText('main')).toBeInTheDocument();
    expect(screen.getByTitle('abcdef123456')).toBeInTheDocument();
    // scripts block + detected files
    expect(screen.getByText('package.json scripts')).toBeInTheDocument();
    expect(screen.getByText('next build')).toBeInTheDocument();
    expect(screen.getByText('next.config.js')).toBeInTheDocument();
    // monorepo workspace pills (framework pill + framework-less pill)
    expect(screen.getByText('Monorepo packages (2)')).toBeInTheDocument();
    expect(screen.getByText('/apps/web')).toBeInTheDocument();
    expect(screen.getByText('/packages/ui')).toBeInTheDocument();
    expect(screen.getByText('· Next.js')).toBeInTheDocument();
    // deploy notes
    expect(screen.getByText('Deployment notes for Next.js')).toBeInTheDocument();
    expect(screen.getByText('Uses standalone output')).toBeInTheDocument();
  });

  it('renders fallbacks for a sparse analysis and omits empty sections', async () => {
    mockOf(api.insights.get).mockResolvedValue(sparseInsights);
    renderWithProviders(<FrameworkTab serviceId={1} svc={svc({ port: null, build: { installCmd: 'npm i', buildCmd: null, startCmd: null } })} />);

    expect(await screen.findByText('What this repository contains')).toBeInTheDocument();
    // optional facts fall back to an em dash
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    // empty sections are omitted entirely
    expect(screen.queryByText('package.json scripts')).not.toBeInTheDocument();
    expect(screen.queryByText('Detected files:')).not.toBeInTheDocument();
    expect(screen.queryByText(/Monorepo packages/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Deployment notes/)).not.toBeInTheDocument();
    // special settings table: current from build, suggested falls back to —
    expect(screen.getByText('npm i')).toBeInTheDocument();
    expect(screen.getByText('Special Settings — Static Site presets')).toBeInTheDocument();
  });

  it('applies the suggested commands and port, and reports failures', async () => {
    mockOf(api.insights.get).mockResolvedValue(richInsights);
    mockOf(api.services.update).mockResolvedValue({} as never);
    renderWithProviders(<FrameworkTab serviceId={1} svc={svc()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Apply commands & port' }));
    await waitFor(() =>
      expect(api.services.update).toHaveBeenCalledWith(1, {
        port: 3000,
        build: { installCmd: 'pnpm install', buildCmd: 'pnpm build', startCmd: 'pnpm start' },
      }));
    await waitFor(() =>
      expect(toastSpy.toast).toHaveBeenCalledWith('Framework settings applied — redeploy to take effect', 'success'));

    // failure path
    mockOf(api.services.update).mockRejectedValueOnce(new Error('nope') as never);
    fireEvent.click(screen.getByRole('button', { name: 'Apply commands & port' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not apply framework settings', 'error'));
  });

  it('shows the applying pending label while commands are saved', async () => {
    mockOf(api.insights.get).mockResolvedValue(richInsights);
    mockOf(api.services.update).mockReturnValue(new Promise(() => {}) as never);
    renderWithProviders(<FrameworkTab serviceId={1} svc={svc()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Apply commands & port' }));
    expect(await screen.findByText('Applying…')).toBeInTheDocument();
  });

  it('creates selected env vars, skips existing ones and unticked ones', async () => {
    mockOf(api.insights.get).mockResolvedValue(richInsights);
    // Nothing exists yet: both suggestions are created.
    mockOf(api.env.list).mockResolvedValue([] as never);
    mockOf(api.env.create).mockResolvedValue({} as never);
    renderWithProviders(<FrameworkTab serviceId={1} svc={svc()} />);

    await screen.findByText('Special Settings — Next.js presets');
    expect(screen.getByText('Suggested environment variables')).toBeInTheDocument();
    expect(screen.getByText('— runtime mode')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Create selected variables' }));
    await waitFor(() => expect(api.env.create).toHaveBeenCalledTimes(2));
    expect(api.env.create).toHaveBeenCalledWith(1, { key: 'NODE_ENV', value: 'production', isSecret: false });
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('2 environment variables created', 'success'));

    // One exists, one unticked: nothing is written.
    mockOf(api.env.list).mockResolvedValue([{ key: 'NODE_ENV' }] as never);
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[1]!); // untick PORT
    fireEvent.click(screen.getByRole('button', { name: 'Create selected variables' }));
    await waitFor(() =>
      expect(toastSpy.toast).toHaveBeenCalledWith('Suggested variables already exist', 'success'));

    // Mixed outcome: one created, one skipped (singular + "already existed").
    mockOf(api.env.list).mockResolvedValue([{ key: 'NODE_ENV' }] as never);
    fireEvent.click(checkboxes[1]!); // re-tick PORT
    fireEvent.click(screen.getByRole('button', { name: 'Create selected variables' }));
    await waitFor(() =>
      expect(toastSpy.toast).toHaveBeenCalledWith('1 environment variable created, 1 already existed', 'success'));
  });

  it('reports env suggestion failures', async () => {
    mockOf(api.insights.get).mockResolvedValue(richInsights);
    mockOf(api.env.list).mockRejectedValue(new Error('denied') as never);
    renderWithProviders(<FrameworkTab serviceId={1} svc={svc()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Create selected variables' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not apply environment suggestions', 'error'));
  });

  it('shows the creating pending label while env vars are saved', async () => {
    mockOf(api.insights.get).mockResolvedValue(richInsights);
    mockOf(api.env.list).mockReturnValue(new Promise(() => {}) as never);
    renderWithProviders(<FrameworkTab serviceId={1} svc={svc()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Create selected variables' }));
    expect(await screen.findByText('Creating…')).toBeInTheDocument();
  });

  it('re-analyzes from the detected framework card', async () => {
    mockOf(api.insights.get).mockResolvedValue(richInsights);
    mockOf(api.insights.refresh).mockResolvedValue(richInsights);
    renderWithProviders(<FrameworkTab serviceId={1} svc={svc()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Re-analyze' }));
    await waitFor(() => expect(api.insights.refresh).toHaveBeenCalledWith(1));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Repository analysis updated', 'success'));
  });

  it('applies a partial preset whose commands are missing and renders versionless packages', async () => {
    // The shared fixture is `as never`; re-widen it for spreading.
    const rich = richInsights as Record<string, unknown> & { framework: Record<string, unknown> };
    const partialPreset: Record<string, unknown> = {
      ...rich,
      framework: {
        ...rich.framework,
        installCmd: null,
        buildCmd: null,
        startCmd: null,
      },
      workspacePackages: [
        { dir: 'apps/bare', name: null, framework: null, frameworkVersion: null },
      ],
      monorepo: true,
    };
    mockOf(api.insights.get).mockResolvedValue(partialPreset as never);
    renderWithProviders(<FrameworkTab serviceId={1} svc={svc()} />);

    // A versionless, framework-less package chip renders with a bare title.
    expect(await screen.findByText('/apps/bare')).toBeInTheDocument();

    // Applying a preset without commands sends only the port; every command
    // key is omitted from the build object.
    mockOf(api.services.update).mockResolvedValue({ ok: true } as never);
    fireEvent.click(screen.getByRole('button', { name: /apply commands & port/i }));
    await waitFor(() =>
      expect(api.services.update).toHaveBeenCalledWith(1, {
        port: 3000,
        build: {},
      }));
  });

  it('omits the monorepo section when the analysis carries no packages field', async () => {
    const withoutPackages: Record<string, unknown> = { ...(richInsights as object) };
    delete withoutPackages.workspacePackages;
    mockOf(api.insights.get).mockResolvedValue(withoutPackages as never);
    renderWithProviders(<FrameworkTab serviceId={1} svc={svc()} />);

    expect(await screen.findByText('Next.js')).toBeInTheDocument();
    expect(screen.queryByText(/Monorepo packages/)).not.toBeInTheDocument();
  });
});
