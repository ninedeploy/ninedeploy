import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Field, Input } from '../src/components/ui.js';

/**
 * The Field component associates its visible label with a single-form-control
 * child via htmlFor/id (screen readers announce the field name) — while
 * non-control children (button groups, multi-control rows) stay unnamed: a
 * wrapping label would leak its whole text into every descendant button's
 * accessible name and break getByRole queries.
 */
describe('Field label association', () => {
  it('associates the visible label with a single-form-control child', () => {
    render(
      <Field label="Replicas (1-10)">
        <Input value="2" onChange={() => undefined} />
      </Field>,
    );
    const input = screen.getByLabelText('Replicas (1-10)') as HTMLInputElement;
    expect(input.value).toBe('2');
  });

  it('respects an id the caller already provided', () => {
    render(
      <Field label="Port">
        <Input id="custom-port" value="8080" onChange={() => undefined} />
      </Field>,
    );
    expect(screen.getByLabelText('Port').id).toBe('custom-port');
  });

  it('leaves non-control children unnamed', () => {
    render(
      <Field label="Auth method">
        <button type="button">SSH deploy key</button>
      </Field>,
    );
    // The button keeps its own content as its accessible name — nothing leaks
    // in from the Field label.
    expect(screen.getByRole('button', { name: 'SSH deploy key' })).toBeDefined();
    expect(screen.queryByLabelText('Auth method')).toBeNull();
  });
});
