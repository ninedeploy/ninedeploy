import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { TunnelHintCard } from '../src/routes/database/TunnelHintCard.js';
import { renderWithProviders } from './helpers.js';

it('copies the database-specific CLI command without requesting public access', async () => {
  const user = userEvent.setup();
  const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
  try {
    renderWithProviders(<TunnelHintCard db={{ id: 42 }} />);
    expect(screen.getByText('ninedeploy tunnel db 42')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(write).toHaveBeenCalledWith('ninedeploy tunnel db 42');
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  } finally { write.mockRestore(); }
});

it('does not report a successful copy when the clipboard refuses it', async () => {
  const user = userEvent.setup();
  const write = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('clipboard denied'));
  try {
    renderWithProviders(<TunnelHintCard db={{ id: 42 }} />);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(write).toHaveBeenCalledOnce();
    expect(screen.queryByText('Copied')).not.toBeInTheDocument();
  } finally { write.mockRestore(); }
});
