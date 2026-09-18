import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, deferred, renderWithProviders } from './web-utils.js';

const apiMock = vi.hoisted(() => ({
  api: {
    env: {
      list: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    },
  },
}));

vi.mock('../src/lib/api.js', () => apiMock);

import { ToastProvider } from '../src/components/Toast.js';
import { EnvCard } from '../src/components/EnvCard.js';

const VARS = [
  { id: 1, key: 'PORT', value: '3000', isSecret: false },
  { id: 2, key: 'API_KEY', value: 'hunter2', isSecret: true },
];

function renderCard() {
  return renderWithProviders(<EnvCard serviceId={7} />, {
    queryClient: createQueryClient(),
  });
}

/** Locate the Add submit button inside the new-env form (it has no accessible text). */
function getAddButton() {
  return document.querySelector('form button[type="submit"]') as HTMLButtonElement;
}

/** Locate the <form> element wrapping the new-variable inputs. */
function getAddForm() {
  return document.querySelector('form') as HTMLFormElement;
}

describe('EnvCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.api.env.list.mockResolvedValue(VARS);
    apiMock.api.env.create.mockResolvedValue({ id: 3, key: 'K', value: 'v', isSecret: false });
    apiMock.api.env.update.mockResolvedValue({ id: 1, key: 'PORT', value: '8080', isSecret: false });
    apiMock.api.env.remove.mockResolvedValue(undefined);
  });

  it('shows a skeleton while loading', () => {
    apiMock.api.env.list.mockReturnValue(new Promise(() => {}));
    const { container } = renderCard();
    expect(container.querySelector('.animate-pulse')).not.toBeNull();
  });

  it('shows an empty state when there are no variables', async () => {
    apiMock.api.env.list.mockResolvedValue([]);
    renderCard();
    await waitFor(() => expect(screen.getByText('No environment variables.')).toBeInTheDocument());
  });

  it('renders the variable rows with secret markers', async () => {
    renderCard();
    await waitFor(() => expect(screen.getByText('PORT')).toBeInTheDocument());
    expect(screen.getByText('API_KEY')).toBeInTheDocument();
    expect(screen.getByText('secret')).toBeInTheDocument();
    const passwordInputs = document.querySelectorAll('input[type="password"]');
    expect(passwordInputs.length).toBeGreaterThan(0);
  });

  it('adds a new variable on submit', async () => {
    const user = userEvent.setup();
    renderCard();
    await waitFor(() => expect(screen.getByText('PORT')).toBeInTheDocument());
    const keyInput = screen.getByPlaceholderText('KEY') as HTMLInputElement;
    const valueInput = screen.getByPlaceholderText('value') as HTMLInputElement;
    await act(async () => {
      await user.type(keyInput, 'FOO');
      await user.type(valueInput, 'bar');
    });
    await waitFor(() => {
      expect(keyInput.value).toBe('FOO');
      expect(valueInput.value).toBe('bar');
      expect(getAddButton()).not.toBeDisabled();
    });
    await act(async () => {
      fireEvent.submit(getAddForm());
    });
    await waitFor(() =>
      expect(apiMock.api.env.create).toHaveBeenCalledWith(7, { key: 'FOO', value: 'bar', isSecret: false }),
    );
    expect(screen.getByPlaceholderText('KEY')).toHaveValue('');
    expect(screen.getByPlaceholderText('value')).toHaveValue('');
  });

  it('adds a secret variable when the checkbox is checked', async () => {
    const user = userEvent.setup();
    renderCard();
    await waitFor(() => expect(screen.getByText('PORT')).toBeInTheDocument());
    const keyInput = screen.getByPlaceholderText('KEY') as HTMLInputElement;
    const valueInput = screen.getByPlaceholderText('value') as HTMLInputElement;
    await act(async () => {
      await user.type(keyInput, 'SEC');
      await user.type(valueInput, 'x');
      await user.click(screen.getByRole('checkbox'));
    });
    expect(screen.getByPlaceholderText('secret value')).toBeInTheDocument();
    await waitFor(() => {
      expect(keyInput.value).toBe('SEC');
      expect(getAddButton()).not.toBeDisabled();
    });
    await act(async () => {
      fireEvent.submit(getAddForm());
    });
    await waitFor(() =>
      expect(apiMock.api.env.create).toHaveBeenCalledWith(7, { key: 'SEC', value: 'x', isSecret: true }),
    );
  });

  it('does not submit when the key is empty', async () => {
    const user = userEvent.setup();
    renderCard();
    await waitFor(() => expect(screen.getByText('PORT')).toBeInTheDocument());
    await user.type(screen.getByPlaceholderText('value'), 'v');
    expect(getAddButton()).toBeDisabled();
    fireEvent.submit(getAddForm());
    expect(apiMock.api.env.create).not.toHaveBeenCalled();
  });

  it('disables the add button while a create is pending', async () => {
    const d = deferred();
    apiMock.api.env.create.mockReturnValue(d.promise);
    const user = userEvent.setup();
    renderCard();
    await waitFor(() => expect(screen.getByText('PORT')).toBeInTheDocument());
    await user.type(screen.getByPlaceholderText('KEY'), 'FOO');
    await waitFor(() => expect(getAddButton()).toBeEnabled());
    fireEvent.submit(getAddForm());
    await waitFor(() => expect(getAddButton()).toBeDisabled());
    d.resolve({ id: 9, key: 'FOO', value: 'b', isSecret: false });
  });

  it('r217: a refused add keeps what was typed', async () => {
    apiMock.api.env.create.mockRejectedValueOnce(new Error('key must match [A-Z_][A-Z0-9_]*'));
    const user = userEvent.setup();
    renderCard();
    await waitFor(() => expect(screen.getByText('PORT')).toBeInTheDocument());
    await user.type(screen.getByPlaceholderText('KEY'), 'my-key');
    fireEvent.submit(getAddForm());
    await waitFor(() => expect(apiMock.api.env.create).toHaveBeenCalled());
    await waitFor(() => expect(getAddButton()).toBeEnabled());
    expect(screen.getByPlaceholderText('KEY')).toHaveValue('my-key');
  });

  it('saves an edited draft with the save button', async () => {
    const user = userEvent.setup();
    renderCard();
    await waitFor(() => expect(screen.getByText('PORT')).toBeInTheDocument());
    const input = screen.getByDisplayValue('3000');
    const row = input.closest('div.flex.items-center') as HTMLElement;
    await user.type(input, 'X');
    await user.click(within(row).getByTitle('Save'));
    await waitFor(() =>
      expect(apiMock.api.env.update).toHaveBeenCalledWith(7, 1, {
        key: 'PORT',
        value: expect.stringContaining('3000'),
        isSecret: false,
      }),
    );
  });

  it('sends isSecret: true when saving an edit on a secret row', async () => {
    const user = userEvent.setup();
    renderCard();
    await waitFor(() => expect(screen.getByText('API_KEY')).toBeInTheDocument());
    const input = screen.getByPlaceholderText('•••• hidden');
    const row = input.closest('div.flex.items-center') as HTMLElement;
    await user.type(input, '9');
    await user.click(within(row).getByTitle('Save'));
    await waitFor(() =>
      // The classification must ride along on the PATCH — the server preserves
      // it when omitted, but a missing field is exactly how secrets used to be
      // silently demoted to plain vars.
      expect(apiMock.api.env.update).toHaveBeenCalledWith(7, 2, {
        key: 'API_KEY',
        value: expect.stringContaining('hunter2'),
        isSecret: true,
      }),
    );
  });

  it('toasts the failure when a save is rejected', async () => {
    const user = userEvent.setup();
    renderWithProviders(<EnvCard serviceId={7} />, {
      queryClient: createQueryClient(),
      wrapper: (children) => <ToastProvider>{children}</ToastProvider>,
    });
    await waitFor(() => expect(screen.getByText('PORT')).toBeInTheDocument());
    const input = screen.getByDisplayValue('3000');
    const row = input.closest('div.flex.items-center') as HTMLElement;
    apiMock.api.env.update.mockRejectedValueOnce(new Error('409'));
    await user.type(input, 'X');
    await user.click(within(row).getByTitle('Save'));
    // A silent failure left users believing the edit had landed — the toast
    // makes the rejection visible.
    expect(await screen.findByText('Could not save the variable')).toBeInTheDocument();
  });

  it('treats a cleared draft as a real edit (value can be blanked)', async () => {
    const user = userEvent.setup();
    renderCard();
    await waitFor(() => expect(screen.getByText('PORT')).toBeInTheDocument());
    const input = screen.getByDisplayValue('3000');
    const row = input.closest('div.flex.items-center') as HTMLElement;
    expect(within(row).getByTitle('Save')).toBeDisabled();
    await user.clear(input);
    // Clearing is a legitimate edit now — Save enables and the field stays empty.
    expect(within(row).getByTitle('Save')).toBeEnabled();
    expect(input).toHaveValue('');
  });

  it('deletes a variable with the delete button', async () => {
    const user = userEvent.setup();
    renderCard();
    await waitFor(() => expect(screen.getByText('PORT')).toBeInTheDocument());
    const input = screen.getByDisplayValue('3000');
    const row = input.closest('div.flex.items-center') as HTMLElement;
    await user.click(within(row).getByTitle('Delete'));
    await waitFor(() => expect(apiMock.api.env.remove).toHaveBeenCalledWith(7, 1));
  });

  it('filters the variable list once there are more than five rows', async () => {
    apiMock.api.env.list.mockResolvedValue(
      Array.from({ length: 7 }, (_, i) => ({ id: i + 1, key: `VAR_${i}`, value: String(i), isSecret: false })),
    );
    const user = userEvent.setup();
    renderCard();
    // With >5 variables the filter input appears and every row renders.
    const filter = await screen.findByPlaceholderText('Filter keys…');
    expect(screen.getByText('VAR_0')).toBeInTheDocument();
    expect(screen.getByText('VAR_6')).toBeInTheDocument();
    await user.type(filter, 'var_3');
    // Case-insensitive substring match keeps only VAR_3.
    expect(screen.queryByText('VAR_0')).not.toBeInTheDocument();
    expect(screen.getByText('VAR_3')).toBeInTheDocument();
  });

  // ── Raw .env text mode ──────────────────────────────────────────────────

  it('round-trips an edited .env through create / update / remove on apply', async () => {
    renderCard();
    await waitFor(() => expect(screen.getByText('PORT')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Edit as .env' }));
    // Entering raw mode pre-fills the textarea with the current variables.
    const text = screen.getByLabelText('Raw .env content') as HTMLTextAreaElement;
    expect(text.value).toBe('PORT=3000\nAPI_KEY=hunter2');

    fireEvent.change(text, { target: { value: 'PORT=8080\nNEW_FLAG=1\n# trailing comment\nexport OLD_STYLE="quoted"' } });
    fireEvent.click(screen.getByRole('button', { name: /Apply 3 vars/ }));

    await waitFor(() => {
      expect(apiMock.api.env.update).toHaveBeenCalledWith(7, 1, { key: 'PORT', value: '8080' });
      expect(apiMock.api.env.create).toHaveBeenCalledWith(7, { key: 'NEW_FLAG', value: '1', isSecret: false });
      // export prefix and surrounding quotes are syntactic, not stored.
      expect(apiMock.api.env.create).toHaveBeenCalledWith(7, { key: 'OLD_STYLE', value: 'quoted', isSecret: false });
      // API_KEY no longer exists in the pasted text → deleted.
      expect(apiMock.api.env.remove).toHaveBeenCalledWith(7, 2);
    });
  });

  it('blocks Apply and lists problems when a line is malformed', async () => {
    renderCard();
    await waitFor(() => expect(screen.getByText('PORT')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Edit as .env' }));
    const text = screen.getByLabelText('Raw .env content') as HTMLTextAreaElement;
    fireEvent.change(text, { target: { value: 'GOOD=1\nthis line has no equals' } });

    expect(screen.getByText(/Line 2: expected KEY=VALUE/)).toBeInTheDocument();
    const apply = screen.getByRole('button', { name: /Apply/ });
    expect(apply).toBeDisabled();

    // Fixing the line re-enables saving.
    fireEvent.change(text, { target: { value: 'GOOD=1' } });
    expect(screen.getByRole('button', { name: /Apply 1 var\b/ })).toBeEnabled();
  });
});
