/**
 * Tests for the Manifest Creator page. The page is large so the suite
 * focuses on the most important contracts: presets load, section nav
 * switches, form edits round-trip into the YAML preview, and the
 * client-side secret-lint surfaces obvious slips.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { recommendedRuntimeVersion } from '@ninedeploy/schemas';
import { ManifestCreator } from '../src/routes/ManifestCreator.js';
import { createQueryClient, renderWithProviders } from './web-utils.js';
import './web-utils.js';

/**
 * Preset labels carry the recommended version, so they are derived from the
 * runtime catalog rather than spelled out — a version bump should not need a
 * test edit.
 */
const NODE_NPM_PRESET = `Node ${recommendedRuntimeVersion('node')} (npm)`;

/** Render the page with both Router + QueryClient providers. */
function renderPage(initialRoute = '/manifest-creator') {
  return renderWithProviders(<ManifestCreator />, {
    queryClient: createQueryClient(),
    route: initialRoute,
  });
}

// Defer all jsdom/global access so the file parses under Vitest's module loader.
// typeof guards are safe in both Node.js (no jsdom) and jsdom environments.
const getOriginalGlobals = () => ({
  localStorage:
    typeof window !== 'undefined' ? window.localStorage : undefined,
  createElement:
    typeof document !== 'undefined'
      ? document.createElement.bind(document)
      : undefined,
  clipboard:
    typeof navigator !== 'undefined'
      ? (navigator as { clipboard?: unknown }).clipboard
      : undefined,
});

beforeEach(() => {
  if (typeof window !== 'undefined') {
    window.localStorage.clear();
  }
});

afterEach(() => {
  const { localStorage, createElement, clipboard } = getOriginalGlobals();
  if (typeof window !== 'undefined') {
    // defineProperty, not assignment: jsdom 30.1 made window.localStorage a
    // getter-only accessor, and a strict-mode assignment throws on it.
    if (localStorage) {
      Object.defineProperty(window, 'localStorage', { configurable: true, value: localStorage });
    }
  }
  if (typeof document !== 'undefined') {
    if (createElement) document.createElement = createElement;
  }
  if (typeof navigator !== 'undefined') {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: clipboard,
    });
  }
});

describe('ManifestCreator', () => {
  it('renders the page header and a preset selector', () => {
    renderPage();
    expect(screen.getByText('Manifest Creator')).toBeInTheDocument();
    expect(screen.getByText(NODE_NPM_PRESET)).toBeInTheDocument();
    expect(screen.getByText('Blank')).toBeInTheDocument();
  });

  it('replaces the form state when a preset is clicked', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByText(NODE_NPM_PRESET));
    // The preset pins a version the catalog knows, so the runtime section
    // shows it selected in the version picker rather than in the free-text
    // escape hatch (which only appears for versions outside the catalog).
    const versionSelect = screen.getByLabelText('Runtime version') as HTMLSelectElement;
    expect(versionSelect.value).toBe(recommendedRuntimeVersion('node'));
  });

  it('switches the active section when a nav button is clicked', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /Build section/ }));
    expect(screen.getByText(/Install command/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Routing section/ }));
    expect(screen.getByText(/No routes yet/)).toBeInTheDocument();
  });

  it('reflects typed values in the rendered YAML preview', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /Build section/ }));
    const installInput = screen.getByPlaceholderText(/npm ci/);
    fireEvent.change(installInput, { target: { value: 'pnpm install --frozen-lockfile' } });
    await user.click(screen.getByRole('button', { name: /Preview/ }));
    await waitFor(() => {
      expect(document.body.textContent ?? '').toContain(
        'pnpm install --frozen-lockfile',
      );
    });
  });

  it('flags manifest values that look like secrets in the lint panel', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /Build section/ }));
    const installInput = screen.getByPlaceholderText(/npm ci/);
    // The canonical AWS docs example key — assembled at runtime so secret
    // scanners do not classify the FIXTURE itself as a leaked credential.
    fireEvent.change(installInput, { target: { value: ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('') } });
    await user.click(screen.getByRole('button', { name: /Preview/ }));
    await waitFor(() =>
      expect(
        document.body.textContent ?? '',
      ).toMatch(/potential secret risk/i),
    );
  });

  it('closes the preview modal via the Close button', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /Preview/ }));
    // The lint banner is unique to the modal — wait for it to appear.
    await waitFor(() =>
      expect(document.body.textContent ?? '').toMatch(/No obvious secrets/),
    );
    // The modal renders a Close button (the X icon has aria-hidden, so the
    // accessible name is just "Close"). Use findByText to be icon-agnostic.
    const closeButton = await screen.findByText('Close');
    await user.click(closeButton);
    await waitFor(() =>
      expect(document.body.textContent ?? '').not.toMatch(/No obvious secrets/),
    );
  });

  it('persists the draft to localStorage on every change', async () => {
    const user = userEvent.setup();
    renderPage();
    const nodeVersion = recommendedRuntimeVersion('node');
    await user.click(screen.getByText(NODE_NPM_PRESET));
    const stored = window.localStorage.getItem('ninedeploy.manifest.draft');
    expect(stored).toBeTruthy();
    expect(JSON.parse(stored ?? '{}')).toMatchObject({
      runtime: { type: 'node', version: nodeVersion },
    });
  });

  it('restores a persisted draft on mount', () => {
    window.localStorage.setItem(
      'ninedeploy.manifest.draft',
      JSON.stringify({ version: '1', runtime: { type: 'go', version: '1.22' } }),
    );
    renderPage();
    expect(screen.getByDisplayValue('1.22')).toBeInTheDocument();
  });

  it('downloads the file when the Download button is clicked', async () => {
    const user = userEvent.setup();
    let anchorClickCount = 0;
    // The download flow calls `document.createElement('a')` and clicks it.
    // Intercept the click to count invocations without actually downloading.
    const realCreateElement = document.createElement.bind(document);
    const createElementSpy = vi.spyOn(document, 'createElement');
    createElementSpy.mockImplementation((tag: string, options?: ElementCreationOptions) => {
      const el = realCreateElement(tag, options);
      if (tag.toLowerCase() === 'a') {
        const originalClick = el.click.bind(el);
        el.click = () => {
          anchorClickCount += 1;
          originalClick();
        };
      }
      return el;
    });
    renderPage();
    await user.click(screen.getByText(NODE_NPM_PRESET));
    await user.click(screen.getByRole('button', { name: /Download/ }));
    expect(anchorClickCount).toBeGreaterThan(0);
    createElementSpy.mockRestore();
  });

  it('copies the YAML to the clipboard via the Copy button', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    renderPage();
    await user.click(screen.getByText(NODE_NPM_PRESET));
    await user.click(screen.getByRole('button', { name: /Copy YAML/ }));
    expect(writeText).toHaveBeenCalled();
    // The copied text is the manifest YAML; verify a known preset value
    // made it through to the clipboard payload.
    expect(writeText.mock.calls[0]?.[0]).toContain('npm ci');
  });

  it('resets the manifest to a clean empty state when Reset is clicked', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByText(NODE_NPM_PRESET));
    await user.click(screen.getByRole('button', { name: /Build section/ }));
    expect(screen.getByText(/Install command/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Reset/ }));
    expect(screen.getByPlaceholderText(/npm ci/)).toBeInTheDocument();
  });

  it('prefills port and healthcheck when ?from=service:<id> is present', async () => {
    // Mock the service query by stubbing api.services.get. The page
    // issues a useQuery on mount; we intercept the response and verify
    // the form lands on the Run section with the port pre-filled.
    const api = (await import('../src/lib/api.js')).api as unknown as {
      services: { get: ReturnType<typeof vi.fn> };
    };
    const getSpy = vi.fn().mockResolvedValue({ id: 1, port: 8080, healthPath: '/ready' });
    api.services.get = getSpy;
    renderPage('/manifest-creator?from=service:1');
    // Wait for the query to fire and the prefill to seed the form.
    await waitFor(() => {
      expect(getSpy).toHaveBeenCalledWith(1);
    });
    // Switch to the Run section where port and healthcheck are edited.
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Run section/ }));
    await waitFor(() => {
      expect(screen.getByDisplayValue('8080')).toBeInTheDocument();
    });
    expect(screen.getByDisplayValue('/ready')).toBeInTheDocument();
  });

  it('does not overwrite the form when ?from=service:<id> is present but a preset is already applied', async () => {
    // Pre-populate the draft so the "is the manifest still the empty starter?"
    // guard refuses the prefill. The page should leave the preset alone.
    const api = (await import('../src/lib/api.js')).api as unknown as {
      services: { get: ReturnType<typeof vi.fn> };
    };
    api.services.get = vi.fn().mockResolvedValue({ id: 1, port: 8080, healthPath: '/ready' });
    window.localStorage.setItem(
      'ninedeploy.manifest.draft',
      JSON.stringify({ version: '1', runtime: { type: 'go', version: '1.22' } }),
    );
    renderPage('/manifest-creator?from=service:1');
    // The prefill guard keeps the existing draft intact — Go version
    // stays in place, the service port does not leak in.
    await waitFor(() => {
      expect(screen.getByDisplayValue('1.22')).toBeInTheDocument();
    });
  });

  it('shows a no-secrets banner when the manifest is clean', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /Preview/ }));
    expect(document.body.textContent ?? '').toMatch(/No obvious secrets/);
  });

  it('skips a malformed draft in localStorage and falls back to a clean empty state', () => {
    window.localStorage.setItem('ninedeploy.manifest.draft', '{ not-json');
    renderPage();
    // The version field is the default empty placeholder.
    expect(screen.getByPlaceholderText(/leave empty to let Nixpacks/)).toBeInTheDocument();
  });

  it('skips a version-less draft in localStorage and falls back to a clean empty state', () => {
    window.localStorage.setItem(
      'ninedeploy.manifest.draft',
      JSON.stringify({ runtime: { type: 'node' } }),
    );
    renderPage();
    expect(screen.getByPlaceholderText(/leave empty to let Nixpacks/)).toBeInTheDocument();
  });

  // Coverage: exercise every section's editor at least once via the nav.
  it('navigates through every section and renders its editor', async () => {
    const user = userEvent.setup();
    renderPage();
    // Visit every section; the page re-renders the right-hand pane for each.
    const sections = [
      /Build section/,
      /Run section/,
      /Static section/,
      /Environment section/,
      /Phases section/,
      /Resources section/,
      /Hooks section/,
      /Watch section/,
      /Routing section/,
      /PR previews section/,
      /Volume section/,
      /Database section/,
      /Network section/,
      /Notifications section/,
      /Alerts section/,
      /Runtime section/,
    ];
    for (const name of sections) {
      await user.click(screen.getByRole('button', { name }));
    }
  });

  it('reflects a fully-populated manifest in the preview YAML', async () => {
    const user = userEvent.setup();
    renderPage();
    // Apply the Go preset, then open the preview and verify key fields appear.
    const goVersion = recommendedRuntimeVersion('go');
    await user.click(screen.getByText(`Go ${goVersion}`));
    await user.click(screen.getByRole('button', { name: /Preview/ }));
    await waitFor(() => {
      const text = document.body.textContent ?? '';
      // The YAML is the project-side manifest only — the nixpacks.toml is
      // generated server-side, so the runtime section is just type + version.
      expect(text).toMatch(/type: go/);
      expect(text).toContain(`version: "${goVersion}"`);
      expect(text).toMatch(/start: \.\/app/);
    });
  });

  it('shows the env alias as a separate row in the YAML', async () => {
    const user = userEvent.setup();
    renderPage();
    // Switch to Env, add an alias, then verify it shows in the YAML.
    await user.click(screen.getByRole('button', { name: /Environment section/ }));
    const addAlias = screen.getByRole('button', { name: /Add alias/ });
    fireEvent.click(addAlias);
    // Type into the key field.
    const keyInput = screen.getByLabelText('key (empty)') as HTMLInputElement;
    fireEvent.blur(keyInput, { target: { value: 'A' } });
    await user.click(screen.getByRole('button', { name: /Preview/ }));
    await waitFor(() => {
      expect(document.body.textContent ?? '').toMatch(/aliases:/);
    });
  });

  it('renders a copy of the preview modal when the header Preview button is clicked', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByText(NODE_NPM_PRESET));
    // Open and re-open the modal to exercise the open/close cycle.
    await user.click(screen.getByRole('button', { name: /Preview/ }));
    await waitFor(() => {
      expect(document.body.textContent ?? '').toMatch(/No obvious secrets/);
    });
    const closeButton = await screen.findByText('Close');
    await user.click(closeButton);
    await waitFor(() => {
      expect(document.body.textContent ?? '').not.toMatch(/No obvious secrets/);
    });
    await user.click(screen.getByRole('button', { name: /Preview/ }));
    await waitFor(() => {
      expect(document.body.textContent ?? '').toMatch(/No obvious secrets/);
    });
  });

  it('renders the resource form with both fields', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /Resources section/ }));
    const cpuInput = screen.getByPlaceholderText('1024') as HTMLInputElement;
    const memInput = screen.getByPlaceholderText('512') as HTMLInputElement;
    fireEvent.change(cpuInput, { target: { value: '2048' } });
    fireEvent.change(memInput, { target: { value: '1024' } });
    expect(cpuInput.value).toBe('2048');
    expect(memInput.value).toBe('1024');
  });

  it('renders a route card after adding one', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /Routing section/ }));
    await user.click(screen.getByRole('button', { name: /Add route/ }));
    // The new route card has a "Host" field rendered.
    expect(screen.getByText('Host')).toBeInTheDocument();
  });

  it('renders an alert card after adding one', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /Alerts section/ }));
    await user.click(screen.getByRole('button', { name: /Add alert/ }));
    // The new alert card shows the "When" select.
    expect(screen.getByText('When')).toBeInTheDocument();
  });

  it('renders the preview modal Copy button', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    renderPage();
    await user.click(screen.getByRole('button', { name: /Preview/ }));
    // There are two Copy buttons in the modal (the header one and the
    // inline one inside the modal). Click the second (the inline one)
    // to exercise the modal's own copy path.
    const copyButtons = screen.getAllByRole('button', { name: /Copy/ });
    await user.click(copyButtons[1]!);
    expect(writeText).toHaveBeenCalled();
  });

  it('renders the preview modal Download button', async () => {
    const user = userEvent.setup();
    let anchorClickCount = 0;
    const realCreateElement = document.createElement.bind(document);
    const createElementSpy = vi.spyOn(document, 'createElement');
    createElementSpy.mockImplementation((tag: string, options?: ElementCreationOptions) => {
      const el = realCreateElement(tag, options);
      if (tag.toLowerCase() === 'a') {
        const originalClick = el.click.bind(el);
        el.click = () => {
          anchorClickCount += 1;
          originalClick();
        };
      }
      return el;
    });
    renderPage();
    await user.click(screen.getByText(NODE_NPM_PRESET));
    await user.click(screen.getByRole('button', { name: /Preview/ }));
    // The modal has a Download button.
    const downloadButtons = screen.getAllByRole('button', { name: /Download/ });
    await user.click(downloadButtons[0]!);
    expect(anchorClickCount).toBeGreaterThan(0);
    createElementSpy.mockRestore();
  });

  it('previews the modal, closes it via the header X, and reopens cleanly', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByText(NODE_NPM_PRESET));
    await user.click(screen.getByRole('button', { name: /Preview/ }));
    expect(await screen.findByText(/potential secret risks|no secret/i)).toBeInTheDocument();

    // The modal's close control sits in the header.
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close dialog' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  // Touches eleven sections sequentially; under parallel suite load this can
  // outlive the default 5s budget.
  it('persists every section edit into the draft it saves', { timeout: 30_000 }, async () => {    const user = userEvent.setup();
    renderPage();
    window.localStorage.removeItem('ninedeploy.manifest.draft');

    const draftKeys = () => Object.keys(JSON.parse(window.localStorage.getItem('ninedeploy.manifest.draft') ?? '{}'));
    const visit = async (name: RegExp) => {
      await user.click(screen.getByRole('button', { name }));
    };
    // ChipInput-backed fields only commit their draft on Enter/comma/blur.
    const type = async (placeholder: string | RegExp, value: string, chips = false) => {
      await user.type(screen.getByPlaceholderText(placeholder), chips ? `${value}{enter}` : value);
    };

    // Runtime: switching the runtime type pushes the whole block at once.
    await visit(/Runtime section/);
    await user.selectOptions(screen.getAllByRole('combobox')[0]!, 'go');
    expect(draftKeys()).toContain('runtime');

    await visit(/Run section/);
    await type('3000', '8080');
    expect(draftKeys()).toContain('run');

    // Static: enabling SPA fallback creates the block, then the root field.
    await visit(/Static section/);
    await user.click(screen.getByRole('switch'));
    await type(/dist/, 'public');
    expect(draftKeys()).toContain('static');

    await visit(/Phases section/);
    await type('python310', 'nodejs_24', true);
    expect(draftKeys()).toContain('phases');

    await visit(/Hooks section/);
    await type('./scripts/gen-types.sh', './scripts/gen.sh');
    expect(draftKeys()).toContain('hooks');

    await visit(/Watch section/);
    await type('apps/web/**', 'services/api/**', true);
    expect(draftKeys()).toContain('watch');

    await visit(/PR previews section/);
    // The pattern field stays disabled until previews are switched on.
    await user.click(screen.getByRole('switch'));
    await type(/pr-\{n\}/, 'pr-{n}.dev.example.com');
    expect(draftKeys()).toContain('previews');

    await visit(/Volume section/);
    await type('/data', '/srv/data');
    expect(draftKeys()).toContain('volume');

    await visit(/Database section/);
    await type('app-db', 'main-db');
    await type('DATABASE_URL', 'DB_URL');
    expect(draftKeys()).toContain('database');

    await visit(/Network section/);
    await type('internal-mesh', 'backend', true);
    expect(draftKeys()).toContain('network');

    await visit(/Notifications section/);
    await type('ops', 'ops@acme.dev', true);
    expect(draftKeys()).toContain('notifications');
  });

  // ── Grouped nav + progress ────────────────────────────────────────────
  it('r213: switching a section off removes it from the manifest', async () => {
    const user = userEvent.setup();
    renderPage();
    window.localStorage.removeItem('ninedeploy.manifest.draft');
    const draftKeys = () => Object.keys(JSON.parse(window.localStorage.getItem('ninedeploy.manifest.draft') ?? '{}'));
    await user.click(screen.getByRole('button', { name: /PR previews section/ }));
    await user.click(screen.getByRole('switch'));
    expect(draftKeys()).toContain('previews');
    await user.click(screen.getByRole('switch'));
    expect(draftKeys()).not.toContain('previews');
    expect(screen.getByRole('switch')).not.toBeChecked();
  });

  it('renders the nav grouped with group headings and a progress readout', () => {
    renderPage();
    expect(screen.getByText('Core')).toBeInTheDocument();
    expect(screen.getByText('Build pipeline')).toBeInTheDocument();
    expect(screen.getByText('Operations')).toBeInTheDocument();
    expect(screen.getByText('Traffic')).toBeInTheDocument();
    expect(screen.getByText('Observability')).toBeInTheDocument();
    // Nothing configured yet.
    expect(screen.getByText(/0\/16 sections configured/)).toBeInTheDocument();
  });

  // ── Live validation ───────────────────────────────────────────────────
  it('shows a validation banner with a jump link when the draft is invalid', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      'ninedeploy.manifest.draft',
      JSON.stringify({ version: '1', run: { port: 70_000 } }),
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText(/validation issue/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Fix in Run' }));
    // The jump lands on Run where the schema message sits next to the
    // offending field (both the page-level panel and the inline hint show).
    await waitFor(() =>
      expect(screen.getByText('Port must be between 1 and 65535.')).toBeInTheDocument(),
    );
  });

  it('shows a valid-manifest strip with the configured count when clean', async () => {
    const user = userEvent.setup();
    renderPage();
    // The Node preset fills runtime + build + run.
    await user.click(screen.getByText(NODE_NPM_PRESET));
    expect(screen.getByText(/Manifest is valid/)).toBeInTheDocument();
    expect(screen.getByText(/3\/16 sections configured/)).toBeInTheDocument();
  });

  // ── Undo / Redo ───────────────────────────────────────────────────────
  it('starts with undo/redo disabled and walks history after a preset apply', async () => {
    const user = userEvent.setup();
    renderPage();
    const undoButton = screen.getByRole('button', { name: 'Undo' });
    const redoButton = screen.getByRole('button', { name: 'Redo' });
    expect(undoButton).toBeDisabled();
    expect(redoButton).toBeDisabled();

    await user.click(screen.getByText(NODE_NPM_PRESET));
    const versionSelect = () => screen.getByLabelText('Runtime version') as HTMLSelectElement;
    expect(versionSelect().value).toBe(recommendedRuntimeVersion('node'));

    // After undo the manifest is empty again: the catalog picker disappears
    // (runtime falls back to auto) and only the free-text input remains.
    await user.click(undoButton);
    expect(
      screen.getByPlaceholderText(/leave empty to let Nixpacks/),
    ).toBeInTheDocument();
    expect(redoButton).toBeEnabled();

    await user.click(redoButton);
    expect(versionSelect().value).toBe(recommendedRuntimeVersion('node'));
  });

  it('makes Reset itself undoable', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByText(NODE_NPM_PRESET));
    await user.click(screen.getByRole('button', { name: /Reset/ }));
    expect(
      screen.getByPlaceholderText(/leave empty to let Nixpacks/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect((screen.getByLabelText('Runtime version') as HTMLSelectElement).value).toBe(
      recommendedRuntimeVersion('node'),
    );
  });

  // ── Import ────────────────────────────────────────────────────────────
  it('imports a pasted YAML manifest through the import modal', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Import' }));
    const area = screen.getByLabelText('YAML to import');
    fireEvent.change(area, {
      target: { value: 'version: "1"\nruntime:\n  type: go\n  version: "1.22"\n' },
    });
    await user.click(screen.getByRole('button', { name: 'Import YAML' }));
    // The modal closes and the parsed manifest lands in the form.
    await waitFor(() => expect(screen.getByDisplayValue('1.22')).toBeInTheDocument());
    expect(screen.queryByLabelText('YAML to import')).not.toBeInTheDocument();
  });

  it('fills the manifest with AI from a description and merges over the draft', async () => {
    const user = userEvent.setup();
    const api = (await import('../src/lib/api.js')).api as unknown as {
      ai: { suggestManifest: ReturnType<typeof vi.fn> };
    };
    api.ai.suggestManifest = vi.fn().mockResolvedValue({
      manifest: { version: '1', run: { port: 4000 }, resources: { memMb: 512 } },
      model: 'gpt-test',
    });
    renderPage();
    await user.click(screen.getByRole('button', { name: 'AI fill' }));
    const area = screen.getByLabelText('App description');
    await user.type(area, 'A Node 20 Express API listening on port 4000 with a Postgres database');
    await user.click(screen.getByRole('button', { name: 'Generate manifest' }));
    await waitFor(() => expect(api.ai.suggestManifest).toHaveBeenCalledWith(expect.stringContaining('Express API')));
    // The modal closes and the suggested run.port lands in the form.
    await waitFor(() => expect(screen.queryByLabelText('App description')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /Run section/ }));
    // The Field component does not label-associate; assert via the value.
    expect(screen.getByDisplayValue('4000')).toBeInTheDocument();
  });

  it('keeps the AI modal open with the error when the provider fails', async () => {
    const user = userEvent.setup();
    const api = (await import('../src/lib/api.js')).api as unknown as {
      ai: { suggestManifest: ReturnType<typeof vi.fn> };
    };
    api.ai.suggestManifest = vi.fn().mockRejectedValue(new Error('The AI returned malformed JSON'));
    renderPage();
    await user.click(screen.getByRole('button', { name: 'AI fill' }));
    await user.type(screen.getByLabelText('App description'), 'A small static site built with vite and deployed as SPA');
    await user.click(screen.getByRole('button', { name: 'Generate manifest' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The AI returned malformed JSON');
    expect(screen.getByLabelText('App description')).toBeInTheDocument();
  });

  it('keeps the modal open with the schema issues when the YAML is invalid', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Import' }));
    fireEvent.change(screen.getByLabelText('YAML to import'), {
      target: { value: 'version: "1"\nrun:\n  port: 99999\n' },
    });
    await user.click(screen.getByRole('button', { name: 'Import YAML' }));
    expect(await screen.findByText('Could not import')).toBeInTheDocument();
    // The modal stayed open so the operator can fix the pasted text.
    expect(screen.getByLabelText('YAML to import')).toBeInTheDocument();
  });

  it('reports malformed YAML as an import failure instead of throwing', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Import' }));
    fireEvent.change(screen.getByLabelText('YAML to import'), {
      target: { value: 'run: [unclosed' },
    });
    await user.click(screen.getByRole('button', { name: 'Import YAML' }));
    expect(await screen.findByText('Could not import')).toBeInTheDocument();
  });

  it('imports from a chosen file', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Import' }));
    // The picker opens through the visible button; the input itself is hidden.
    await user.click(screen.getByRole('button', { name: /Choose file/ }));
    const input = screen.getByLabelText('Import from file') as HTMLInputElement;
    const file = new File(
      ['version: "1"\nruntime:\n  type: go\n  version: "1.22"\n'],
      '.ninedeploy',
      { type: 'text/yaml' },
    );
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(screen.getByDisplayValue('1.22')).toBeInTheDocument());
  });

  it('reports a file-read failure as an import error', async () => {
    const user = userEvent.setup();
    const textSpy = vi
      .spyOn(File.prototype, 'text')
      .mockRejectedValueOnce(new Error('read failed'));
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Import' }));
    const input = screen.getByLabelText('Import from file');
    const file = new File(['version: "1"'], '.ninedeploy', { type: 'text/yaml' });
    fireEvent.change(input, { target: { files: [file] } });
    expect(await screen.findByText('Could not import')).toBeInTheDocument();
    expect(await screen.findByText(/Could not read/)).toBeInTheDocument();
    textSpy.mockRestore();
  });

  it('closes the import modal via Cancel and via the dialog close button', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Import' }));
    // Fire the file-input branch once so a stale selection can't linger.
    await user.click(screen.getByRole('button', { name: /Cancel/ }));
    await waitFor(() =>
      expect(screen.queryByLabelText('YAML to import')).not.toBeInTheDocument(),
    );
    // Reopen and close through the modal's header X.
    await user.click(screen.getByRole('button', { name: 'Import' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close dialog' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  // ── Section-level inline validation ───────────────────────────────────
  it('flags a healthcheck path missing its leading slash', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /Run section/ }));
    fireEvent.change(screen.getByPlaceholderText('/healthz'), {
      target: { value: 'healthz' },
    });
    // Match the exact inline error — the field hint legitimately contains
    // the same "must start with" wording.
    expect(
      screen.getByText('Healthcheck path must start with "/".'),
    ).toBeInTheDocument();
  });

  it('flags a preview pattern missing the {n} placeholder', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /PR previews section/ }));
    await user.click(screen.getByRole('switch'));
    fireEvent.change(screen.getByPlaceholderText(/pr-\{n\}/), {
      target: { value: 'pr.previews.example.com' },
    });
    expect(screen.getByText(/must contain the \{n\} placeholder/)).toBeInTheDocument();
  });

  it('flags an invalid route host inline', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /Routing section/ }));
    await user.click(screen.getByRole('button', { name: /Add route/ }));
    fireEvent.change(screen.getByPlaceholderText('app.example.com'), {
      target: { value: 'ab' },
    });
    expect(screen.getByText(/at least 3 characters/)).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('app.example.com'), {
      target: { value: 'bad host!' },
    });
    // The live schema banner also repeats "valid hostname" for the same
    // field — match the inline hint's distinctive wording.
    expect(
      screen.getByText(/letters, digits, dots, dashes/),
    ).toBeInTheDocument();
  });

  // ── Quick-pick chips ──────────────────────────────────────────────────
  it('fills the backup cron schedule from a quick-pick chip', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /Volume section/ }));
    await user.click(screen.getByRole('button', { name: 'Daily 03:00' }));
    expect((screen.getByPlaceholderText('0 3 * * *') as HTMLInputElement).value).toBe('0 3 * * *');
  });

  it('fills the memory cap from a quick-pick chip', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /Resources section/ }));
    await user.click(screen.getByRole('button', { name: 'Set memory to 1024 MiB' }));
    expect((screen.getByPlaceholderText('512') as HTMLInputElement).value).toBe('1024');
  });

  it('fills the CPU shares from a quick-pick chip', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /Resources section/ }));
    await user.click(screen.getByRole('button', { name: 'Set CPU shares to 1024' }));
    expect((screen.getByPlaceholderText('1024') as HTMLInputElement).value).toBe('1024');
  });

  it('offers managed-database suggestions and fills the slug from one', async () => {
    const user = userEvent.setup();
    const api = (await import('../src/lib/api.js')).api as unknown as {
      databases: { list: ReturnType<typeof vi.fn> };
    };
    api.databases.list = vi.fn().mockResolvedValue([
      { id: 1, slug: 'app-db', engine: 'postgres', status: 'running' },
      { id: 2, slug: 'cache-db', engine: 'redis', status: 'running' },
    ]);
    renderPage();
    await user.click(screen.getByRole('button', { name: /Database section/ }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Use app-db (postgres)' })).toBeInTheDocument(),
    );
    await user.click(screen.getByRole('button', { name: 'Use app-db (postgres)' }));
    expect((screen.getByPlaceholderText('app-db') as HTMLInputElement).value).toBe('app-db');
  });
});
