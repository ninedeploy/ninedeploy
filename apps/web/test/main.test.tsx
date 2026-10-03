import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  createRoot: vi.fn(),
  render: vi.fn(),
}));

vi.mock('react-dom/client', () => ({
  createRoot: mocks.createRoot,
}));

vi.mock('../src/App.js', () => ({
  default: () => <div>app-stub</div>,
}));

describe('main.tsx', () => {
  let rootEl: HTMLDivElement;

  beforeEach(() => {
    vi.resetModules();
    mocks.createRoot.mockReset();
    mocks.render.mockReset();
    rootEl = document.createElement('div');
    rootEl.id = 'root';
    document.body.appendChild(rootEl);
    mocks.createRoot.mockReturnValue({ render: mocks.render });
  });

  afterEach(() => {
    rootEl.remove();
  });

  it('creates a root on #root and renders the app once', async () => {
    await import('../src/main.js');
    expect(mocks.createRoot).toHaveBeenCalledWith(rootEl);
    expect(mocks.render).toHaveBeenCalledTimes(1);
    // the tree is a React element (not yet mounted, render is mocked)
    expect(mocks.render.mock.calls[0]?.[0]).toBeTruthy();
  });

  it('throws when the #root element is missing', async () => {
    rootEl.remove();
    await expect(import('../src/main.js')).rejects.toThrow('Root element #root not found');
  });
});
