import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ModeProvider, useExperienceMode } from '../src/lib/mode.js';
import { ModeToggle } from '../src/components/ModeToggle.js';

afterEach(() => {
  cleanup();
});

function TestConsumer() {
  const { mode, isAdvanced, isSimple, setMode, toggleMode } = useExperienceMode();
  return (
    <div>
      <span data-testid="mode">{mode}</span>
      <span data-testid="isAdvanced">{String(isAdvanced)}</span>
      <span data-testid="isSimple">{String(isSimple)}</span>
      <button type="button" onClick={toggleMode} data-testid="toggle">Toggle</button>
      <button type="button" onClick={() => setMode('advanced')} data-testid="setAdvanced">Set Advanced</button>
      <button type="button" onClick={() => setMode('simple')} data-testid="setSimple">Set Simple</button>
    </div>
  );
}

describe('Experience Mode Context & Toggle', () => {
  it('provides default simple mode and toggles to advanced', () => {
    localStorage.clear();
    render(
      <ModeProvider>
        <TestConsumer />
        <ModeToggle />
      </ModeProvider>,
    );

    expect(screen.getByTestId('mode')).toHaveTextContent('simple');
    expect(screen.getByTestId('isSimple')).toHaveTextContent('true');
    expect(screen.getByTestId('isAdvanced')).toHaveTextContent('false');
    expect(screen.getByText('Simple View')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('toggle'));

    expect(screen.getByTestId('mode')).toHaveTextContent('advanced');
    expect(screen.getByTestId('isAdvanced')).toHaveTextContent('true');
    expect(screen.getByText('DevOps Pro')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /devops pro/i }));
    expect(screen.getByTestId('mode')).toHaveTextContent('simple');
  });

  it('restores initial saved mode from localStorage', () => {
    localStorage.setItem('ninedeploy_experience_mode', 'advanced');
    render(
      <ModeProvider>
        <TestConsumer />
      </ModeProvider>,
    );
    expect(screen.getByTestId('mode')).toHaveTextContent('advanced');
    expect(screen.getByTestId('isAdvanced')).toHaveTextContent('true');

    fireEvent.click(screen.getByTestId('setSimple'));
    expect(screen.getByTestId('mode')).toHaveTextContent('simple');
    expect(localStorage.getItem('ninedeploy_experience_mode')).toBe('simple');
  });

  it('handles useExperienceMode outside of provider with safe fallbacks', () => {
    render(<TestConsumer />);
    expect(screen.getByTestId('mode')).toHaveTextContent('simple');
    expect(screen.getByTestId('isSimple')).toHaveTextContent('true');
    // Calling safe fallbacks without crashing
    fireEvent.click(screen.getByTestId('toggle'));
    fireEvent.click(screen.getByTestId('setAdvanced'));
  });
});
