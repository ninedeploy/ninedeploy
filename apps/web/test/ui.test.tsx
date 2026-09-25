import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import './web-utils.js';
import { rejectPanelAutofill } from '../src/lib/autofill.js';
import {
  AutofillRejectingInput,
  Badge,
  BrandMark,
  Button,
  Card,
  CardBody,
  ConfirmDialog,
  EmptyState,
  ErrorCard,
  Field,
  FullScreenSpinner,
  Input,
  Modal,
  PageHeader,
  Select,
  Skeleton,
  Spinner,
  StatCard,
  StatusBadge,
  Switch,
  Table,
  Tabs,
  Textarea,
  Tooltip,
  cn,
} from '../src/components/ui.js';

describe('cn', () => {
  it('joins truthy parts and drops falsy ones', () => {
    expect(cn('a', false, 'b', null, undefined, 'c')).toBe('a b c');
  });

  it('returns an empty string for all-falsy input', () => {
    expect(cn(false, null)).toBe('');
  });
});

describe('BrandMark', () => {
  it('renders the 9 glyph with default size', () => {
    render(<BrandMark />);
    expect(screen.getByText('9')).toBeInTheDocument();
    expect(screen.getByText('9').style.width).toBe('28px');
  });

  it('honors a custom size', () => {
    render(<BrandMark size={48} />);
    const mark = screen.getByText('9');
    expect(mark.style.width).toBe('48px');
    expect(mark.style.height).toBe('48px');
  });
});

describe('Button', () => {
  it('renders with default variant/size classes and children', () => {
    render(<Button>Go</Button>);
    const btn = screen.getByRole('button', { name: 'Go' });
    expect(btn).toBeInTheDocument();
    expect(btn.className).toContain('text-white');
    expect(btn.className).toContain('h-10');
  });

  it('applies variant and size classes', () => {
    render(
      <Button variant="danger" size="sm">
        Del
      </Button>,
    );
    const btn = screen.getByRole('button', { name: 'Del' });
    expect(btn.className).toContain('bg-rose-500/90');
    expect(btn.className).toContain('h-8');
  });

  it('renders ghost and secondary variants', () => {
    const { rerender } = render(
      <Button variant="ghost" size="lg">
        g
      </Button>,
    );
    expect(screen.getByRole('button', { name: 'g' }).className).toContain('text-slate-300');
    rerender(
      <Button variant="secondary">
        s
      </Button>,
    );
    expect(screen.getByRole('button', { name: 's' }).className).toContain('bg-white/[0.06]');
  });

  it('merges className and honors disabled state', () => {
    render(
      <Button className="extra" disabled>
        x
      </Button>,
    );
    const btn = screen.getByRole('button', { name: 'x' });
    expect(btn.className).toContain('extra');
    expect(btn).toBeDisabled();
  });

  it('forwards the ref', () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button ref={ref}>r</Button>);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });
});

describe('Card / CardBody', () => {
  it('renders a non-interactive card', () => {
    render(<Card>hi</Card>);
    expect(screen.getByText('hi')).toBeInTheDocument();
    expect(screen.getByText('hi').className).not.toContain('hover:shadow-xl');
  });

  it('renders an interactive card', () => {
    render(<Card interactive>hi</Card>);
    expect(screen.getByText('hi').className).toContain('hover:shadow-xl');
  });

  it('CardBody applies padding and children', () => {
    render(<CardBody>body</CardBody>);
    expect(screen.getByText('body').className).toContain('p-5');
  });
});

describe('Input / Textarea / Select', () => {
  it('renders an input with forwarded ref and className', () => {
    const ref = createRef<HTMLInputElement>();
    render(<Input ref={ref} className="mine" placeholder="p" />);
    const el = screen.getByPlaceholderText('p');
    expect(el).toBeInstanceOf(HTMLInputElement);
    expect(ref.current).toBe(el);
    expect(el.className).toContain('mine');
  });

  it('renders a textarea with forwarded ref', () => {
    const ref = createRef<HTMLTextAreaElement>();
    render(<Textarea ref={ref} aria-label="notes" />);
    const el = screen.getByLabelText('notes');
    expect(el).toBeInstanceOf(HTMLTextAreaElement);
    expect(ref.current).toBe(el);
  });

  it('renders a select with options and forwarded ref', () => {
    const ref = createRef<HTMLSelectElement>();
    render(
      <Select ref={ref} aria-label="pick">
        <option value="a">A</option>
      </Select>,
    );
    const el = screen.getByLabelText('pick');
    expect(el).toBeInstanceOf(HTMLSelectElement);
    expect(ref.current).toBe(el);
    expect(el.className).toContain('appearance-none');
  });
});

describe('Field', () => {
  it('renders the label and children', () => {
    render(
      <Field label="Email">
        <input aria-label="Email" />
      </Field>,
    );
    expect(screen.getByText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });

  it('renders the optional hint next to the label', () => {
    render(
      <Field label="Token" hint="Found under Settings → API">
        <input aria-label="Token" />
      </Field>,
    );
    expect(screen.getByText('Found under Settings → API')).toBeInTheDocument();
  });
});

describe('StatusBadge', () => {
  it.each(['running', 'idle', 'deploying', 'error', 'stopped', 'deleting', 'queued', 'building', 'failed', 'active'])(
    'renders the %s status with a tone class',
    (status) => {
      render(<StatusBadge status={status} />);
      const badge = screen.getByText(status);
      expect(badge).toBeInTheDocument();
      expect(badge.className).toContain('ring-1');
    },
  );

  it('falls back to the neutral tone for unknown statuses', () => {
    render(<StatusBadge status="weird" />);
    const badge = screen.getByText('weird');
    expect(badge.className).toContain('bg-slate-500/15');
  });
});

describe('Spinner / Skeleton / FullScreenSpinner', () => {
  it('renders a spinner svg with custom className', () => {
    const { container } = render(<Spinner className="big" />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('class')).toContain('big');
  });

  it('renders a full-screen spinner', () => {
    const { container } = render(<FullScreenSpinner />);
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('renders a skeleton with custom className', () => {
    const { container } = render(<Skeleton className="w-1/2" />);
    expect(container.querySelector('div')?.className).toContain('w-1/2');
  });
});

describe('EmptyState', () => {
  it('renders title alone', () => {
    render(<EmptyState title="Nothing" />);
    expect(screen.getByText('Nothing')).toBeInTheDocument();
  });

  it('renders icon, hint and action when provided', () => {
    render(
      <EmptyState
        icon={<span>ic</span>}
        title="Nothing"
        hint="Try again"
        action={<button type="button">Act</button>}
      />,
    );
    expect(screen.getByText('ic')).toBeInTheDocument();
    expect(screen.getByText('Try again')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Act' })).toBeInTheDocument();
  });
});

describe('Tabs', () => {
  const tabs = [
    { id: 'a', label: 'Alpha' },
    { id: 'b', label: 'Beta', count: 3 },
  ];

  it('marks the active tab and reports clicks on inactive ones', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Tabs tabs={tabs} active="a" onChange={onChange} />);
    const alpha = screen.getByRole('tab', { name: /Alpha/ });
    expect(alpha).toHaveAttribute('aria-selected', 'true');
    const beta = screen.getByRole('tab', { name: /Beta/ });
    expect(beta).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByText('3')).toBeInTheDocument();
    await user.click(beta);
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('omits the count badge when no count is given', () => {
    render(<Tabs tabs={tabs} active="b" onChange={() => {}} />);
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });
});

describe('ErrorCard', () => {
  it('renders a default message for non-Error values', () => {
    render(<ErrorCard error="boom" />);
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText('Unexpected error')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('shows the Error message and a retry button', () => {
    const onRetry = vi.fn();
    render(<ErrorCard title="Load failed" error={new Error('network down')} onRetry={onRetry} />);
    expect(screen.getByText('Load failed')).toBeInTheDocument();
    expect(screen.getByText('network down')).toBeInTheDocument();
    const btn = screen.getByRole('button', { name: 'Try again' });
    btn.click();
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

describe('Modal', () => {
  it('renders title, children and footer; closes via backdrop, Escape and X', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Modal title="My Dialog" onClose={onClose} footer={<Button>Save</Button>}>
        <p>Body text</p>
      </Modal>,
    );
    const dialog = screen.getByRole('dialog');
    expect(screen.getByText('My Dialog')).toBeInTheDocument();
    expect(screen.getByText('Body text')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();

    // Backdrop click closes (the backdrop button precedes the panel).
    (dialog.previousElementSibling as HTMLElement | null)!.click();
    expect(onClose).toHaveBeenCalledTimes(1);

    // Escape closes.
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);

    // Explicit X button closes.
    screen.getByRole('button', { name: 'Close dialog' }).click();
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('locks and restores body scroll while open', () => {
    const { unmount } = render(
      <Modal title="T" onClose={() => {}}>
        x
      </Modal>,
    );
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(document.body.style.overflow).toBe('');
  });

  it('traps Tab focus inside the dialog', async () => {
    const user = userEvent.setup();
    render(
      <Modal title="T" onClose={() => {}}>
        <input aria-label="first" />
        <button type="button">second</button>
      </Modal>,
    );
    // Panel content is the first focusable after the close button; Tab from
    // the last element wraps back to the first.
    const second = screen.getByRole('button', { name: 'second' });
    second.focus();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close dialog' }));
  });

  it('wraps Shift+Tab from the first focusable to the last', async () => {
    const user = userEvent.setup();
    render(
      <Modal title="T" onClose={() => {}}>
        <input aria-label="first" />
        <button type="button">second</button>
      </Modal>,
    );
    const close = screen.getByRole('button', { name: 'Close dialog' });
    close.focus();
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'second' }));
  });

  it('lets Tab move naturally when focus is on a middle element', async () => {
    const user = userEvent.setup();
    render(
      <Modal title="T" onClose={() => {}}>
        <button type="button">one</button>
        <button type="button">two</button>
        <button type="button">three</button>
      </Modal>,
    );
    const two = screen.getByRole('button', { name: 'two' });
    two.focus();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'three' }));
  });

  it('no-ops Tab when the dialog has no focusable children', async () => {
    const user = userEvent.setup();
    render(
      <Modal title="T" onClose={() => {}}>
        <p>plain text</p>
      </Modal>,
    );
    await user.tab();
    expect(screen.getByText('plain text')).toBeInTheDocument();
  });

  it('uses the wide layout and omits aria-label for non-string titles', () => {
    render(
      <Modal wide title={<em>Styled</em>} onClose={() => {}}>
        <p>w</p>
      </Modal>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('max-w-3xl');
    expect(dialog).not.toHaveAttribute('aria-label');
  });

  it('focuses the element referenced by initialFocusRef on open', () => {
    const ref = createRef<HTMLInputElement>();
    render(
      <Modal title="T" onClose={() => {}} initialFocusRef={ref}>
        <Input ref={ref} aria-label="target" />
      </Modal>,
    );
    expect(screen.getByLabelText('target')).toHaveFocus();
  });

  it('keeps focus in a controlled input while the owner re-renders per keystroke', async () => {
    // Regression: every route passes `onClose` as a fresh inline arrow, so
    // each keystroke in a controlled form field handed Modal a new callback
    // identity. The trap effect treated that as an open transition, re-ran
    // its "focus first element" step and yanked the caret to the ✕ button —
    // one keypress typed, focus gone, everywhere a dialog had a text input.
    function Host() {
      const [name, setName] = useState('');
      return (
        <Modal title="New project" onClose={() => {}}>
          <Input aria-label="name" value={name} onChange={(e) => setName(e.target.value)} />
          <Input aria-label="slug" value="" onChange={() => {}} />
        </Modal>
      );
    }
    render(<Host />);
    const name = screen.getByLabelText('name');
    await userEvent.setup().type(name, 'abc');
    expect(name).toHaveFocus();
    expect(name).toHaveValue('abc');
  });

  it('hands focus back to the control that opened it on close (r293)', async () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <Button onClick={() => setOpen(true)}>Open settings</Button>
          {open && (
            <Modal title="Settings" onClose={() => setOpen(false)}>
              <Input aria-label="field" autoFocus />
            </Modal>
          )}
        </>
      );
    }
    render(<Host />);
    const user = userEvent.setup();
    const opener = screen.getByRole('button', { name: 'Open settings' });
    await user.click(opener);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(opener).not.toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('does not try to refocus an opener that left the DOM (r293)', async () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          {!open && <Button onClick={() => setOpen(true)}>Open</Button>}
          {open && (
            <Modal title="T" onClose={() => setOpen(false)}>
              body
            </Modal>
          )}
        </>
      );
    }
    render(<Host />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(document.body);
  });
});

describe('ConfirmDialog', () => {
  it('renders nothing when closed', () => {
    render(<ConfirmDialog open={false} title="t" message="m" onConfirm={() => {}} onClose={() => {}} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('confirms immediately without a confirm word', () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(<ConfirmDialog open title="Delete?" message="Sure?" onConfirm={onConfirm} onClose={onClose} />);
    screen.getByRole('button', { name: 'Delete' }).click();
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('requires typing the confirm word before enabling the danger button', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog open title="Danger" message="no undo" confirmWord="myapp" onConfirm={onConfirm} onClose={() => {}} />,
    );
    const btn = screen.getByRole('button', { name: 'Delete' });
    expect(btn).toBeDisabled();
    await user.type(screen.getByPlaceholderText('myapp'), 'myap');
    expect(btn).toBeDisabled();
    await user.type(screen.getByPlaceholderText('myapp'), 'p');
    expect(btn).toBeEnabled();
    btn.click();
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('resets the typed word when reopened', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const { rerender } = render(
      <ConfirmDialog open={false} title="t" message="m" confirmWord="zap" onConfirm={onConfirm} onClose={() => {}} />,
    );
    rerender(<ConfirmDialog open title="t" message="m" confirmWord="zap" onConfirm={onConfirm} onClose={() => {}} />);
    await user.type(screen.getByPlaceholderText('zap'), 'zap');
    expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled();
    rerender(<ConfirmDialog open={false} title="t" message="m" confirmWord="zap" onConfirm={onConfirm} onClose={() => {}} />);
    rerender(<ConfirmDialog open title="t" message="m" confirmWord="zap" onConfirm={onConfirm} onClose={() => {}} />);
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
  });
});

describe('Switch', () => {
  it('toggles on click and reports the new value', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Switch checked={false} onChange={onChange} label="Auto-deploy" />);
    const sw = screen.getByRole('switch', { name: 'Auto-deploy' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    await user.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('disables interaction when disabled', () => {
    render(<Switch checked onChange={() => {}} disabled label="d" />);
    expect(screen.getByRole('switch')).toBeDisabled();
  });
});

describe('PageHeader', () => {
  it('renders icon, title, subtitle and actions', () => {
    render(
      <PageHeader icon={<span>ic</span>} title="Services" subtitle="All workloads" actions={<Button>New</Button>} />,
    );
    expect(screen.getByText('ic')).toBeInTheDocument();
    expect(screen.getByText('Services')).toBeInTheDocument();
    expect(screen.getByText('All workloads')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New' })).toBeInTheDocument();
  });

  it('omits subtitle and actions when not provided', () => {
    const { container } = render(<PageHeader title="Bare" />);
    expect(container.firstElementChild!.className).toContain('mb-6');
  });
});

describe('Table', () => {
  it('renders column headers and body rows', () => {
    render(
      <Table columns={['Name', 'Status']}>
        <tr>
          <td>api</td>
          <td>running</td>
        </tr>
      </Table>,
    );
    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Status' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'api' })).toBeInTheDocument();
  });
});

describe('Badge', () => {
  it.each(['neutral', 'indigo', 'emerald', 'amber', 'rose', 'sky'] as const)('renders the %s tone', (tone) => {
    render(<Badge tone={tone}>{tone}</Badge>);
    expect(screen.getByText(tone).className).toContain('ring-1');
  });
});

describe('StatCard', () => {
  it('renders label, value, icon and hint', () => {
    render(<StatCard icon={<span>i</span>} label="CPU" value="42%" hint="of 8 cores" />);
    expect(screen.getByText('CPU')).toBeInTheDocument();
    expect(screen.getByText('42%')).toBeInTheDocument();
    expect(screen.getByText('of 8 cores')).toBeInTheDocument();
    expect(screen.getByText('i')).toBeInTheDocument();
  });
});

describe('Tooltip', () => {
  it('exposes content in a tooltip role tied to the trigger', () => {
    render(
      <Tooltip content="Helpful text">
        <button type="button">hover me</button>
      </Tooltip>,
    );
    expect(screen.getByRole('tooltip')).toHaveTextContent('Helpful text');
    expect(screen.getByRole('button', { name: 'hover me' })).toBeInTheDocument();
  });
});

describe('AutofillRejectingInput', () => {
  it('unlocks on keyboard interaction and forwards the onKeyDown prop', () => {
    const onKeyDown = vi.fn();
    render(<AutofillRejectingInput aria-label="kb" onKeyDown={onKeyDown} />);
    const field = screen.getByLabelText<HTMLInputElement>('kb');
    expect(field).toHaveAttribute('readonly');

    fireEvent.keyDown(field, { key: 'a' });
    expect(field).not.toHaveAttribute('readonly');
    expect(onKeyDown).toHaveBeenCalledTimes(1);
  });

  it('clears values reported by a detected browser autofill', () => {
    // The animation-event path itself cannot be delivered under jsdom (React
    // skips animation delegation there), so exercise the rejection directly.
    const onAutofillRejected = vi.fn();
    render(<AutofillRejectingInput aria-label="af" onAutofillRejected={onAutofillRejected} />);
    const field = screen.getByLabelText<HTMLInputElement>('af');
    field.value = 'injected';
    rejectPanelAutofill(field, onAutofillRejected);
    expect(field).toHaveValue('');
    expect(onAutofillRejected).toHaveBeenCalledTimes(1);
  });
});

import {
  ChipInput,
  KeyValueEditor,
  ListEditor,
  PresetSelector,
} from '../src/components/ui.js';

const { useState: _useStateImported } = { useState };
type PresetOption<T> = { id: string; label: string; description?: string; manifest: T };

describe('ChipInput', () => {
  it('renders existing chips with a remove button each', () => {
    render(<ChipInput value={['A', 'B']} onChange={() => {}} />);
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByText('B')).toBeInTheDocument();
    expect(screen.getByLabelText('Remove A')).toBeInTheDocument();
    expect(screen.getByLabelText('Remove B')).toBeInTheDocument();
  });

  it('shows a placeholder when there are no chips', () => {
    render(<ChipInput value={[]} onChange={() => {}} placeholder="add a key" />);
    expect(screen.getByPlaceholderText('add a key')).toBeInTheDocument();
  });

  it('adds a chip on Enter, trims whitespace, and clears the input', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ChipInput value={[]} onChange={onChange} />);
    const input = screen.getByRole('textbox');
    await user.type(input, '  NEW_KEY  {enter}');
    expect(onChange).toHaveBeenCalledWith(['NEW_KEY']);
  });

  it('adds a chip on comma too', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ChipInput value={[]} onChange={onChange} />);
    const input = screen.getByRole('textbox');
    await user.type(input, 'A,B{enter}');
    // Two commits: one for 'A' (on comma), one for 'B' (on enter). The second
    // call replaces the value, so we look at the full mock.calls list.
    expect(onChange.mock.calls.map((c) => c[0])).toEqual([['A'], ['B']]);
  });

  it('adds a chip on blur when there is a draft', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ChipInput value={[]} onChange={onChange} />);
    const input = screen.getByRole('textbox');
    await user.type(input, 'X');
    input.blur();
    expect(onChange).toHaveBeenCalledWith(['X']);
  });

  it('does not commit a blank draft', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ChipInput value={['A']} onChange={onChange} />);
    const input = screen.getByRole('textbox');
    await user.type(input, '   {enter}');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('rejects chips that fail the pattern', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ChipInput value={[]} onChange={onChange} pattern={/^[A-Z]+$/} />);
    const input = screen.getByRole('textbox');
    await user.type(input, 'lower{enter}');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('drops duplicate chips', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ChipInput value={['A']} onChange={onChange} />);
    const input = screen.getByRole('textbox');
    await user.type(input, 'A{enter}');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('removes a chip when the X is clicked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ChipInput value={['A', 'B']} onChange={onChange} />);
    await user.click(screen.getByLabelText('Remove A'));
    expect(onChange).toHaveBeenCalledWith(['B']);
  });

  it('removes the last chip when backspace is pressed in an empty draft', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ChipInput value={['A', 'B']} onChange={onChange} />);
    const input = screen.getByRole('textbox');
    await user.click(input);
    await user.keyboard('{Backspace}');
    expect(onChange).toHaveBeenCalledWith(['A']);
  });

  it('shows the label and hint when provided', () => {
    render(<ChipInput value={[]} onChange={() => {}} label="Keys" hint="one per env" />);
    expect(screen.getByText('Keys')).toBeInTheDocument();
    expect(screen.getByText('one per env')).toBeInTheDocument();
  });

  it('hides the input when disabled', () => {
    render(<ChipInput value={['A']} onChange={() => {}} disabled />);
    const input = screen.getByRole('textbox');
    expect(input).toBeDisabled();
  });

  it('unlocks the autofill guard on pointer-down so the user can type', () => {
    // The guard is unlocked the moment the user touches the input via
    // pointer; the readOnly flag flips from true to false on the second
    // pointerdown. We exercise that path so the autofill contract stays
    // observable in tests.
    render(<AutofillRejectingInput aria-label="af" />);
    const field = screen.getByLabelText<HTMLInputElement>('af');
    expect(field.readOnly).toBe(true);
    fireEvent.pointerDown(field);
    expect(field.readOnly).toBe(false);
  });
});

describe('KeyValueEditor', () => {
  it('renders one row per entry with the right initial values', () => {
    render(<KeyValueEditor value={{ A: '1', B: '2' }} onChange={() => {}} />);
    const a = screen.getByLabelText('key A') as HTMLInputElement;
    const aVal = screen.getByLabelText('value for A') as HTMLInputElement;
    expect(a.value).toBe('A');
    expect(aVal.value).toBe('1');
  });

  it('adds a new empty row when the Add button is clicked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<KeyValueEditor value={{}} onChange={onChange} addLabel="Add pair" />);
    await user.click(screen.getByRole('button', { name: 'Add pair' }));
    expect(onChange).toHaveBeenCalledWith({ '': '' });
  });

  it('focuses the existing empty row when Add is pressed again (no silent no-op)', async () => {
    const user = userEvent.setup({ delay: null });
    function Harness() {
      const [value, setValue] = useState<Record<string, string>>({ '': '' });
      return <KeyValueEditor value={value} onChange={setValue} addLabel="Add pair" />;
    }
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: 'Add pair' }));
    // The focus is scheduled on the next animation frame — flush it.
    await new Promise((r) => setTimeout(r, 30));

    const emptyKey = screen.getByLabelText('key (empty)') as HTMLInputElement;
    expect(document.activeElement).toBe(emptyKey);
  });

  it('renames the key on blur of the key input', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<KeyValueEditor value={{ A: '1' }} onChange={onChange} />);
    const keyInput = screen.getByLabelText('key A') as HTMLInputElement;
    await user.clear(keyInput);
    await user.type(keyInput, 'B');
    fireEvent.blur(keyInput);
    expect(onChange).toHaveBeenLastCalledWith({ B: '1' });
  });

  it('updates the value on blur of the value input', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<KeyValueEditor value={{ A: '1' }} onChange={onChange} />);
    const valInput = screen.getByLabelText('value for A') as HTMLInputElement;
    await user.clear(valInput);
    await user.type(valInput, '2');
    fireEvent.blur(valInput);
    expect(onChange).toHaveBeenLastCalledWith({ A: '2' });
  });

  it('drops the row when the key becomes empty (no empty keys leak through)', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<KeyValueEditor value={{ A: '1' }} onChange={onChange} />);
    const keyInput = screen.getByLabelText('key A') as HTMLInputElement;
    await user.clear(keyInput);
    fireEvent.blur(keyInput);
    expect(onChange).toHaveBeenLastCalledWith({});
  });

  it('rewrites the same key when rename leaves it unchanged (no row removed)', () => {
    const onChange = vi.fn();
    render(<KeyValueEditor value={{ A: '1' }} onChange={onChange} />);
    const keyInput = screen.getByLabelText('key A') as HTMLInputElement;
    // Re-focus + re-blur without changing the value: should still emit a
    // setRow call so the parent sees the row (covers the "keep existing
    // entry" branch of the rename logic).
    keyInput.focus();
    fireEvent.blur(keyInput);
    expect(onChange).toHaveBeenLastCalledWith({ A: '1' });
  });

  it('preserves untouched rows when renaming one of two', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<KeyValueEditor value={{ A: '1', B: '2' }} onChange={onChange} />);
    const keyA = screen.getByLabelText('key A') as HTMLInputElement;
    await user.clear(keyA);
    await user.type(keyA, 'A2');
    fireEvent.blur(keyA);
    // The rename touches row A; row B is iterated over and copied through
    // the `next[k] = v` branch. Both rows must be present in the result.
    expect(onChange).toHaveBeenLastCalledWith({ A2: '1', B: '2' });
  });

  it('respects validateKey and blocks invalid renames', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <KeyValueEditor
        value={{ A: '1' }}
        onChange={onChange}
        validateKey={(k) => /^[A-Z]+$/.test(k)}
      />,
    );
    const keyInput = screen.getByLabelText('key A') as HTMLInputElement;
    await user.clear(keyInput);
    await user.type(keyInput, 'lowercase');
    fireEvent.blur(keyInput);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('removes a row when the delete button is clicked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<KeyValueEditor value={{ A: '1', B: '2' }} onChange={onChange} />);
    await user.click(screen.getByLabelText('Delete A'));
    expect(onChange).toHaveBeenCalledWith({ B: '2' });
  });

  it('uses a "row" label for the delete button when the key is empty', () => {
    // Add a row, leave the key empty, click delete — the aria-label falls
    // back to the literal "Delete row" so screen readers can still announce
    // the action target.
    render(<KeyValueEditor value={{ '': '' }} onChange={() => {}} />);
    expect(screen.getByLabelText('Delete row')).toBeInTheDocument();
  });
});

describe('ListEditor', () => {
  interface Item {
    name: string;
    value: number;
  }
  const renderItem = (item: Item, update: (next: Item) => void) => (
    <div>
      <input
        aria-label={`name ${item.name}`}
        defaultValue={item.name}
        onBlur={(e) => update({ ...item, name: e.target.value })}
      />
      <input
        aria-label={`value ${item.name}`}
        type="number"
        defaultValue={item.value}
        onBlur={(e) => update({ ...item, value: Number(e.target.value) })}
      />
    </div>
  );

  it('shows an empty state when there are no items', () => {
    render(
      <ListEditor<Item>
        value={[]}
        onChange={() => {}}
        createNew={() => ({ name: 'new', value: 0 })}
        renderItem={renderItem}
        emptyMessage="Nothing yet."
      />,
    );
    expect(screen.getByText('Nothing yet.')).toBeInTheDocument();
  });

  it('renders one card per item with the right itemLabel', () => {
    render(
      <ListEditor<Item>
        value={[{ name: 'A', value: 1 }, { name: 'B', value: 2 }]}
        onChange={() => {}}
        createNew={() => ({ name: 'new', value: 0 })}
        renderItem={renderItem}
        itemLabel={(it) => it.name}
      />,
    );
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByText('B')).toBeInTheDocument();
  });

  it('falls back to "Item N" when no itemLabel is provided', () => {
    render(
      <ListEditor<Item>
        value={[{ name: 'A', value: 1 }]}
        onChange={() => {}}
        createNew={() => ({ name: 'new', value: 0 })}
        renderItem={renderItem}
      />,
    );
    expect(screen.getByText('Item 1')).toBeInTheDocument();
  });

  it('appends a new item when the Add button is clicked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ListEditor<Item>
        value={[]}
        onChange={onChange}
        createNew={() => ({ name: 'fresh', value: 99 })}
        renderItem={renderItem}
        addLabel="Add item"
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Add item' }));
    expect(onChange).toHaveBeenCalledWith([{ name: 'fresh', value: 99 }]);
  });

  it('updates an item through the renderer-supplied update callback', async () => {
    const user = userEvent.setup();
    function Controlled() {
      const [items, setItems] = useState<Item[]>([{ name: 'A', value: 1 }]);
      return (
        <ListEditor<Item>
          value={items}
          onChange={setItems}
          createNew={() => ({ name: 'new', value: 0 })}
          renderItem={renderItem}
        />
      );
    }
    render(<Controlled />);
    // Update via the renderer's onBlur → update path.
    const nameInput = screen.getByLabelText('name A') as HTMLInputElement;
    await user.clear(nameInput);
    await user.type(nameInput, 'A2');
    fireEvent.blur(nameInput);
    expect(screen.getByLabelText<HTMLInputElement>('name A2').value).toBe('A2');
  });

  it('removes an item when the Remove button is clicked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ListEditor<Item>
        value={[{ name: 'A', value: 1 }, { name: 'B', value: 2 }]}
        onChange={onChange}
        createNew={() => ({ name: 'new', value: 0 })}
        renderItem={renderItem}
      />,
    );
    const removeButtons = screen.getAllByLabelText('Remove');
    await user.click(removeButtons[0]!);
    expect(onChange).toHaveBeenCalledWith([{ name: 'B', value: 2 }]);
  });

  it('moves items up and down with the arrow buttons', async () => {
    const user = userEvent.setup();
    // The component reads `value` from props; the only way to observe the
    // effect of a re-order is to thread the new value back through state.
    // Using a controlled wrapper keeps each move independent.
    function Controlled() {
      const [items, setItems] = useState<Item[]>([
        { name: 'A', value: 1 },
        { name: 'B', value: 2 },
        { name: 'C', value: 3 },
      ]);
      return (
        <ListEditor<Item>
          value={items}
          onChange={setItems}
          createNew={() => ({ name: 'new', value: 0 })}
          renderItem={renderItem}
          itemLabel={(it) => `${it.name}-${it.value}`}
        />
      );
    }
    render(<Controlled />);

    // First item can't move up; last item can't move down.
    expect(screen.getAllByLabelText('Move up')[0]).toBeDisabled();
    expect(screen.getAllByLabelText('Move down')[2]).toBeDisabled();

    await user.click(screen.getAllByLabelText('Move up')[1]!); // B up
    // After move, the labels (rendered via itemLabel) are B-2, A-1, C-3.
    const labels1 = screen.getAllByText(/^[ABC]-\d$/).map((n) => n.textContent);
    expect(labels1).toEqual(['B-2', 'A-1', 'C-3']);

    await user.click(screen.getAllByLabelText('Move down')[1]!); // A down (now index 1)
    const labels2 = screen.getAllByText(/^[ABC]-\d$/).map((n) => n.textContent);
    expect(labels2).toEqual(['B-2', 'C-3', 'A-1']);
  });

  it('moveItem on an empty list is a safe no-op', () => {
    // The disabled buttons on the first/last item block the click in
    // normal use, but we exercise the moveItem code path on a one-item
    // list with `up` (out-of-range target) to confirm no error throws.
    function Controlled() {
      const [items, setItems] = useState<Item[]>([{ name: 'A', value: 1 }]);
      return (
        <ListEditor<Item>
          value={items}
          onChange={setItems}
          createNew={() => ({ name: 'new', value: 0 })}
          renderItem={renderItem}
        />
      );
    }
    render(<Controlled />);
    const upButton = screen.getByLabelText('Move up') as HTMLButtonElement;
    expect(upButton.disabled).toBe(true);
    // Force a click on the disabled button — the click handler still
    // runs in jsdom, exercising the moveItem branch with a
    // out-of-range target.
    fireEvent.click(upButton);
    // State should be unchanged: the splice returned undefined and the
    // array stays a single item.
    expect(screen.getByText('Item 1')).toBeInTheDocument();
  });
});

describe('PresetSelector', () => {
  const opts: PresetOption<{ version: '1' }>[] = [
    { id: 'node', label: 'Node 20', description: 'npm-based Node app', manifest: { version: '1' } },
    { id: 'py', label: 'Python 3.12', description: 'pip + FastAPI', manifest: { version: '1' } },
  ];

  it('renders one option per preset with the label and description', () => {
    render(<PresetSelector options={opts} onSelect={() => {}} />);
    expect(screen.getByText('Node 20')).toBeInTheDocument();
    expect(screen.getByText('npm-based Node app')).toBeInTheDocument();
    expect(screen.getByText('Python 3.12')).toBeInTheDocument();
    expect(screen.getByText('pip + FastAPI')).toBeInTheDocument();
  });

  it('emits onSelect with the chosen manifest when an option is clicked', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<PresetSelector options={opts} onSelect={onSelect} />);
    await user.click(screen.getByText('Python 3.12'));
    expect(onSelect).toHaveBeenCalledWith(opts[1]!.manifest);
  });

  it('marks the active option with aria-pressed=true', () => {
    render(<PresetSelector options={opts} onSelect={() => {}} value="py" />);
    const pyButton = screen.getByText('Python 3.12').closest('button')!;
    const nodeButton = screen.getByText('Node 20').closest('button')!;
    expect(pyButton.getAttribute('aria-pressed')).toBe('true');
    expect(nodeButton.getAttribute('aria-pressed')).toBe('false');
  });

  it('renders the label and hint when provided', () => {
    render(
      <PresetSelector
        options={opts}
        onSelect={() => {}}
        label="Start from preset"
        hint="pick the closest match"
      />,
    );
    expect(screen.getByText('Start from preset')).toBeInTheDocument();
    expect(screen.getByText('pick the closest match')).toBeInTheDocument();
  });
});
