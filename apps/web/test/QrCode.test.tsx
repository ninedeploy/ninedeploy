import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QrCode } from '../src/components/QrCode.js';

describe('QrCode component', () => {
  it('renders a placeholder when value is empty', () => {
    render(<QrCode value="" />);
    expect(screen.getByText('Generating QR…')).toBeInTheDocument();
  });

  it('renders a QR code image when value is provided', async () => {
    render(<QrCode value="otpauth://totp/NineDeploy:test@example.com?secret=JBSWY3DPEHPK3PXP" alt="Custom QR" size={160} />);
    const img = await screen.findByAltText('Custom QR');
    expect(img).toBeInTheDocument();
    await waitFor(() => expect(img.getAttribute('src')).toMatch(/^data:image\/png;base64,/));
  });
  it('handles QRCode generation failure gracefully', async () => {
    const QRCode = (await import('qrcode')).default;
    const spy = vi.spyOn(QRCode, 'toDataURL').mockRejectedValueOnce(new Error('Canvas error'));
    render(<QrCode value="bad-value" />);
    expect(screen.getAllByText('Generating QR…').length).toBeGreaterThanOrEqual(1);
    spy.mockRestore();
  });

  it('handles unmount before QRCode generation finishes', () => {
    const { unmount } = render(<QrCode value="otpauth://totp/test" />);
    unmount();
  });
});
