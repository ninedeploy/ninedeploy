import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { AutofillRejectingInput, Input, Textarea } from '../src/components/ui.js';
import { installPanelAutofillGuard, rejectPanelAutofill } from '../src/lib/autofill.js';

describe('panel autofill protection', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('marks shared text fields so browsers and password managers ignore them', () => {
    render(
      <>
        <Input aria-label="input" />
        <Textarea aria-label="textarea" />
      </>,
    );

    for (const field of [screen.getByLabelText('input'), screen.getByLabelText('textarea')]) {
      expect(field).toHaveAttribute('autocomplete', 'off');
      expect(field).toHaveAttribute('autocorrect', 'off');
      expect(field).toHaveAttribute('autocapitalize', 'none');
      expect(field).toHaveAttribute('spellcheck', 'false');
      expect(field).toHaveAttribute('data-1p-ignore', 'true');
      expect(field).toHaveAttribute('data-lpignore', 'true');
      expect(field).toHaveAttribute('data-bwignore', 'true');
      expect(field).toHaveAttribute('data-form-type', 'other');
    }
  });

  it('hardens raw and dynamically inserted panel fields but leaves non-text controls alone', async () => {
    const root = document.createElement('div');
    const raw = document.createElement('input');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    root.append(raw, checkbox);
    document.body.append(root);

    const cleanup = installPanelAutofillGuard(root);
    expect(raw).toHaveAttribute('autocomplete', 'off');
    expect(checkbox).not.toHaveAttribute('autocomplete');

    const dynamic = document.createElement('textarea');
    root.append(dynamic);
    await waitFor(() => expect(dynamic).toHaveAttribute('data-1p-ignore', 'true'));
    cleanup();
  });

  it('keeps a non-text control untouched when it is itself the guard root', () => {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    document.body.append(checkbox);

    const cleanup = installPanelAutofillGuard(checkbox);
    expect(checkbox).not.toHaveAttribute('autocomplete');
    cleanup();
  });

  it('skips mutation records whose added nodes are not elements', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const cleanup = installPanelAutofillGuard(root);

    root.append(document.createTextNode('plain text'));
    const dynamic = document.createElement('input');
    root.append(dynamic);
    // The text node is ignored without throwing; the real input is hardened.
    await waitFor(() => expect(dynamic).toHaveAttribute('data-1p-ignore', 'true'));
    cleanup();
  });

  it('keeps critical filters locked until user interaction', () => {
    function Example() {
      const [value, setValue] = useState('');
      return (
        <AutofillRejectingInput
          aria-label="safe filter"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onAutofillRejected={() => setValue('')}
        />
      );
    }

    render(<Example />);
    const filter = screen.getByLabelText<HTMLInputElement>('safe filter');
    expect(filter).toHaveAttribute('readonly');

    fireEvent.pointerDown(filter);
    expect(filter).not.toHaveAttribute('readonly');

    fireEvent.change(filter, { target: { value: 'k' } });
    expect(filter).toHaveValue('k');
  });

  it('clears values injected by a detected browser autofill', () => {
    const filter = document.createElement('input');
    filter.value = 'k';
    document.body.append(filter);
    rejectPanelAutofill(filter);
    expect(filter).toHaveValue('');
  });
});
