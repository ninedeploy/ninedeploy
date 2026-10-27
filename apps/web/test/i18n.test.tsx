import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LanguageSwitch } from '../src/components/LanguageSwitch.js';
import { LocaleProvider, fill, useT } from '../src/lib/i18n.js';

function Probe() {
  const t = useT();
  return (
    <p data-testid="probe">
      {t('Sign out')} · {t('{n} running', { n: 2 })} · {fill(t('If an account exists for {email}, a reset link is on its way (valid for 30 minutes).'), { email: <b>a@b.c</b> })}
    </p>
  );
}

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  document.documentElement.lang = '';
});

describe('i18n (G4.6)', () => {
  it('renders English outside a provider', () => {
    render(<Probe />);
    expect(screen.getByTestId('probe').textContent).toContain('Sign out · 2 running · If an account exists for a@b.c');
  });

  it('switches to Turkish, persists the choice and sets the document language', async () => {
    render(
      <LocaleProvider>
        <LanguageSwitch />
        <Probe />
      </LocaleProvider>,
    );
    expect(screen.getByTestId('probe').textContent).toContain('Sign out');
    await userEvent.click(screen.getByRole('button', { name: 'Türkçe' }));
    const text = screen.getByTestId('probe').textContent ?? '';
    expect(text).toContain('Çıkış yap · 2 çalışıyor');
    expect(text).toContain('a@b.c için bir hesap varsa');
    expect(screen.getByTestId('probe').querySelector('b')?.textContent).toBe('a@b.c');
    expect(localStorage.getItem('ninedeploy.locale')).toBe('tr');
    expect(document.documentElement.lang).toBe('tr');
    expect(screen.getByRole('button', { name: 'Türkçe' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('starts from the stored choice, then from a Turkish browser', () => {
    localStorage.setItem('ninedeploy.locale', 'tr');
    const { unmount } = render(<LocaleProvider><Probe /></LocaleProvider>);
    expect(screen.getByTestId('probe').textContent).toContain('Çıkış yap');
    unmount();
    localStorage.clear();
    vi.stubGlobal('navigator', { ...navigator, language: 'tr-TR' });
    render(<LocaleProvider><Probe /></LocaleProvider>);
    expect(screen.getByTestId('probe').textContent).toContain('Çıkış yap');
  });

  it('ignores an unknown stored locale', () => {
    localStorage.setItem('ninedeploy.locale', 'xx');
    render(<LocaleProvider><Probe /></LocaleProvider>);
    expect(screen.getByTestId('probe').textContent).toContain('Sign out');
  });
});
