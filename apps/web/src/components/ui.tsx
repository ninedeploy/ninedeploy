import {
  type ButtonHTMLAttributes,
  cloneElement,
  type InputHTMLAttributes,
  isValidElement,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Plus, X } from 'lucide-react';
import { rejectPanelAutofill } from '../lib/autofill.js';

export const cn = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

// ── Brand ─────────────────────────────────────────────────────────────────
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <span
      className="grid place-items-center rounded-xl font-bold text-white shadow-lg shadow-indigo-500/30"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.5,
        background: 'linear-gradient(135deg, var(--nd-accent) 0%, var(--nd-accent-strong) 100%)',
      }}
    >
      9
    </span>
  );
}

// ── Button ────────────────────────────────────────────────────────────────
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

const VARIANTS: Record<Variant, string> = {
  primary:
    'text-white shadow-lg shadow-indigo-500/25 hover:shadow-indigo-500/40 hover:brightness-110 [background-image:linear-gradient(135deg,var(--nd-accent),var(--nd-accent-strong))]',
  secondary: 'bg-white/[0.06] hover:bg-white/[0.1] text-slate-100 ring-1 ring-inset ring-white/10',
  ghost: 'hover:bg-white/[0.08] text-slate-300',
  danger: 'bg-rose-500/90 hover:bg-rose-500 text-white',
};
const SIZES: Record<Size, string> = { sm: 'h-8 px-3 text-xs', md: 'h-10 px-4 text-sm', lg: 'h-11 px-5 text-sm' };

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }
>(function Button({ variant = 'primary', size = 'md', className, ...props }, ref) {
  return (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-all duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/70 focus-visible:ring-offset-1 focus-visible:ring-offset-slate-950',
        'disabled:opacity-50 disabled:pointer-events-none active:scale-[0.98]',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    />
  );
});

// ── Card ──────────────────────────────────────────────────────────────────
export function Card({
  className,
  children,
  interactive,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { interactive?: boolean }) {
  return (
    <div
      className={cn(
        'rounded-2xl border border-white/[0.08] bg-white/[0.025] backdrop-blur-sm',
        interactive &&
          'cursor-pointer transition-all duration-200 hover:border-white/15 hover:bg-white/[0.04] hover:shadow-xl hover:shadow-black/40',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('p-5', className)}>{children}</div>;
}

// ── Inputs ────────────────────────────────────────────────────────────────
const fieldBase =
  'w-full rounded-lg bg-black/30 px-3 text-sm text-slate-100 ring-1 ring-inset ring-white/10 placeholder:text-slate-500 transition focus:outline-none focus:ring-2 focus:ring-indigo-400/60 focus:bg-black/40';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="none"
      spellCheck={false}
      data-1p-ignore="true"
      data-lpignore="true"
      data-bwignore="true"
      data-form-type="other"
      className={cn(fieldBase, 'h-10', className)}
      {...props}
    />
  );
});

type AutofillRejectingInputProps = InputHTMLAttributes<HTMLInputElement> & {
  onAutofillRejected?: () => void;
};

/** Blocks browser restoration/autofill until the user deliberately interacts. */
export const AutofillRejectingInput = forwardRef<HTMLInputElement, AutofillRejectingInputProps>(
  function AutofillRejectingInput(
    { onAutofillRejected, onPointerDown, onKeyDown, onAnimationStart, ...props },
    ref,
  ) {
    const [unlocked, setUnlocked] = useState(false);
    const unlock = useCallback(() => setUnlocked(true), []);

    return (
      <Input
        {...props}
        ref={ref}
        readOnly={!unlocked}
        data-nd-reject-autofill="true"
        onPointerDown={(event) => {
          unlock();
          onPointerDown?.(event);
        }}
        onKeyDown={(event) => {
          unlock();
          onKeyDown?.(event);
        }}
        // React only registers animation-event delegation when the host
        // supports the event; jsdom does not, so this browser-only autofill
        // guard cannot be exercised in unit tests.
        onAnimationStart={/* v8 ignore next 10 */ (event) => {
          const animationName = event.animationName || (event.nativeEvent as AnimationEvent).animationName;
          if (animationName === 'nd-autofill-detected') {
            rejectPanelAutofill(event.currentTarget, onAutofillRejected);
          }
          onAnimationStart?.(event);
        }}
      />
    );
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        data-1p-ignore="true"
        data-lpignore="true"
        data-bwignore="true"
        data-form-type="other"
        className={cn(fieldBase, 'py-2', className)}
        {...props}
      />
    );
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, ...props },
  ref,
) {
  return (
    <select ref={ref} className={cn(fieldBase, 'h-10 appearance-none pr-8', className)} {...props} />
  );
});

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  /** Inline validation message rendered in rose below the control. */
  error?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  // Associate the visible label with the control when the Field wraps a
  // single form control (the overwhelmingly common shape) so screen readers
  // announce the field name. Button groups, multi-control rows and fragments
  // keep the previous unnamed behavior — a wrapping label would leak its
  // whole text into every descendant button's accessible name.
  const control =
    isValidElement(children) &&
    (children.type === Input || children.type === Textarea || children.type === Select)
      ? children
      : null;
  const labelClass = 'block text-xs font-semibold uppercase tracking-wide text-slate-400';
  // The label must point at the id the control will ACTUALLY carry: a
  // caller-provided id wins over the generated one.
  const controlId = control ? ((control.props as { id?: string }).id ?? id) : id;
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        {control ? (
          <label htmlFor={controlId} className={labelClass}>
            {label}
          </label>
        ) : (
          <span className={labelClass}>{label}</span>
        )}
        {hint && <span className="text-[11px] text-slate-500">{hint}</span>}
      </div>
      {control
        ? cloneElement(control as ReactElement<{ id?: string }>, { id: controlId })
        : children}
      {error != null && <p className="mt-1.5 text-[11px] leading-relaxed text-rose-300">{error}</p>}
    </div>
  );
}

// ── Tabs ───────────────────────────────────────────────────────────────────
export function Tabs({
  tabs,
  active,
  onChange,
  className,
}: {
  tabs: Array<{ id: string; label: string; count?: number }>;
  active: string;
  onChange: (id: string) => void;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-center gap-1 rounded-xl bg-white/[0.03] p-1 ring-1 ring-inset ring-white/[0.06]', className)}>
      {tabs.map((t) => (
        <button
          type="button"
          key={t.id}
          onClick={() => onChange(t.id)}
          className={cn(
            'rounded-lg px-3 py-1.5 text-xs font-medium transition',
            t.id === active ? 'bg-white/[0.1] text-slate-100 shadow-sm' : 'text-slate-400 hover:text-slate-200',
          )}
          role="tab"
          aria-selected={t.id === active}
        >
          {t.label}
          {t.count != null && <span className="ml-1.5 text-[10px] text-slate-500">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

// ── Badge ─────────────────────────────────────────────────────────────────
const STATUS_TONES: Record<string, string> = {
  running: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/20',
  idle: 'bg-slate-500/15 text-slate-300 ring-slate-500/20',
  superseded: 'bg-slate-500/10 text-slate-400 ring-slate-500/15',
  deploying: 'bg-amber-500/15 text-amber-300 ring-amber-500/20',
  error: 'bg-rose-500/15 text-rose-300 ring-rose-500/20',
  stopped: 'bg-slate-500/15 text-slate-400 ring-slate-500/20',
  deleting: 'bg-amber-500/15 text-amber-300 ring-amber-500/20',
  queued: 'bg-sky-500/15 text-sky-300 ring-sky-500/20',
  building: 'bg-amber-500/15 text-amber-300 ring-amber-500/20',
  failed: 'bg-rose-500/15 text-rose-300 ring-rose-500/20',
  active: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/20',
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset',
        STATUS_TONES[status] ?? 'bg-slate-500/15 text-slate-300 ring-slate-500/20',
      )}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {status}
    </span>
  );
}

// ── Spinner ───────────────────────────────────────────────────────────────
export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cn('animate-spin', className)} viewBox="0 0 24 24" fill="none" width="1em" height="1em" role="status">
      <title>Loading</title>
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

export function FullScreenSpinner() {
  return (
    <div className="grid h-screen place-items-center text-slate-400">
      <Spinner className="h-6 w-6" />
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-white/[0.06]', className)} />;
}

export function EmptyState({ icon, title, hint, action }: { icon?: ReactNode; title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      {icon && (
        <div className="mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-white/[0.04] text-slate-500 ring-1 ring-inset ring-white/10">
          {icon}
        </div>
      )}
      <p className="text-sm font-medium text-slate-200">{title}</p>
      {hint && <p className="mt-1 max-w-xs text-sm text-slate-500">{hint}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

// ── Error state ───────────────────────────────────────────────────────────
export function ErrorCard({ title = 'Something went wrong', error, onRetry }: { title?: string; error?: unknown; onRetry?: () => void }) {
  return (
    <Card className="border-rose-500/20 bg-rose-500/[0.04]">
      <CardBody className="flex flex-col items-start gap-3">
        <div>
          <p className="text-sm font-medium text-rose-200">{title}</p>
          <p className="mt-1 text-xs text-rose-300/70">{error instanceof Error ? error.message : 'Unexpected error'}</p>
        </div>
        {onRetry && (
          <Button variant="secondary" size="sm" onClick={onRetry}>
            Try again
          </Button>
        )}
      </CardBody>
    </Card>
  );
}

// ── Modal ─────────────────────────────────────────────────────────────────
/**
 * Escape-to-close for the few hand-rolled overlays that do not (yet) use
 * Modal (r294). Keyed on nothing the caller re-creates per render, so an
 * inline `onClose` arrow does not reinstall the listener every keystroke.
 */
export function useEscapeToClose(onClose: () => void, enabled = true): void {
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}

/**
 * Shared modal chrome: backdrop click + Escape close, scroll lock, focus
 * trap and initial focus on the first focusable element (or `initialFocusRef`).
 * Extracted from the DeployWizard's hand-rolled implementation so every
 * dialog in the app gets the same accessibility guarantees.
 */
export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
  initialFocusRef,
  open = true,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  /** Defaults to true; set false to hide without unmounting. */
  open?: boolean;
}) {
  // Hooks must be called unconditionally — the early return for `!open`
  // would violate the rules of hooks (and is also why we keep the open
  // check at the JSX level further down).
  const panelRef = useRef<HTMLDivElement>(null);
  const isOpen = open !== false;

  // The scroll lock, key trap and initial focus must depend on whether the
  // dialog IS open — not on whether the caller re-created its callbacks this
  // render. Every page passes `onClose` as a fresh inline arrow, so keying
  // this effect on it used to reinstall everything on every keystroke in a
  // controlled input, and the "focus first element" step yanked the caret
  // out of whatever field the user was typing in. Read callbacks through
  // refs so the listener always sees the latest closure while the effect
  // itself only runs on open/close transitions.
  const onCloseRef = useRef(onClose);
  const initialFocusRefSnapshot = useRef(initialFocusRef);

  useEffect(() => {
    onCloseRef.current = onClose;
    initialFocusRefSnapshot.current = initialFocusRef;
  });

  // r293: remember what had focus when the dialog opened so closing it hands
  // focus back (keyboard users were dropped at the top of the page). Read at
  // render time on the closed→open transition: by the time any effect runs,
  // an autoFocus field inside the dialog has already taken focus.
  const returnFocusRef = useRef<Element | null>(null);
  const wasOpenRef = useRef(false);
  if (isOpen && !wasOpenRef.current) returnFocusRef.current = document.activeElement;
  wasOpenRef.current = isOpen;

  useEffect(() => {
    // The portal only mounts when isOpen; skip side-effects when closed.
    if (!isOpen) return;
    const returnFocus = returnFocusRef.current;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // The panel ref is always attached before this effect runs (refs bind
    // during commit, effects after), so the element is safe to assert.
    const panel = panelRef.current!;
    const focusables = () =>
      Array.from(panel.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')).filter(
        (el) => !(el as HTMLButtonElement).disabled,
      );

    const target = initialFocusRefSnapshot.current?.current ?? focusables()[0];
    target?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
      } else if (e.key === 'Tab') {
        // The header close button is always focusable, so the list is never empty.
        const els = focusables();
        const first = els[0]!;
        const last = els[els.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
      // Skip an opener that has since left the DOM (a row deleted by the
      // dialog's own action) — focusing a detached node is a no-op at best.
      if (returnFocus instanceof HTMLElement && returnFocus.isConnected && returnFocus !== document.body) {
        returnFocus.focus();
      }
    };
  }, [isOpen]);

  const modalContent = (
    <div className="fixed inset-0 z-[9999] flex items-end justify-center sm:items-center p-4 sm:p-6">
      <button
        type="button"
        aria-label="Close dialog"
        tabIndex={-1}
        aria-hidden="true"
        onClick={onClose}
        className="absolute inset-0 bg-black/75 backdrop-blur-sm transition-opacity"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        className={cn(
          'nd-fade relative flex max-h-[90vh] w-full flex-col overflow-hidden rounded-2xl border border-white/10 bg-slate-950 shadow-2xl z-10',
          wide ? 'max-w-3xl' : 'max-w-xl',
        )}
      >
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <h2 className="text-lg font-semibold text-slate-100">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-slate-200 transition"
          >
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-white/10 px-5 py-4 bg-slate-950/50">
            {footer}
          </div>
        )}
      </div>
    </div>
  );

  // When `!open`, render nothing — the hooks above already ran, so
  // rules of hooks is satisfied, and the early return prevents the
  // portal from being created (which would otherwise stay in the DOM
  // and interfere with focus order).
  if (!isOpen) return null;

  // SSR guard: document always exists in the browser (and in jsdom tests).
  /* v8 ignore start */
  if (typeof document !== 'undefined') {
    return createPortal(modalContent, document.body);
  }

  return modalContent;
  /* v8 ignore stop */
}

// ── Confirm dialog ────────────────────────────────────────────────────────
/**
 * The single destructive-action pattern for the whole app:
 * - confirm = 'dialog' (default): small danger modal with a Cancel/Confirm pair.
 * - confirm = 'type': type-the-name confirmation for irreversible damage
 *   (deleting services, volumes).
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Delete',
  confirmWord,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  confirmWord?: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [word, setWord] = useState('');
  // Reset the typed confirmation whenever the dialog reopens.
  useEffect(() => {
    if (open) setWord('');
  }, [open]);
  if (!open) return null;

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={confirmWord != null && word !== confirmWord} onClick={() => { onConfirm(); onClose(); }}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-sm text-slate-300">{message}</div>
      {confirmWord != null && (
        <div className="mt-4">
          <Field label={`Type "${confirmWord}" to confirm`}>
            <Input value={word} onChange={(e) => setWord(e.target.value)} placeholder={confirmWord} autoComplete="off" />
          </Field>
        </div>
      )}
    </Modal>
  );
}

// ── Switch ────────────────────────────────────────────────────────────────
export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'inline-flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/70 focus-visible:ring-offset-1 focus-visible:ring-offset-slate-950',
        'disabled:opacity-50 disabled:pointer-events-none',
        checked ? 'bg-indigo-500' : 'bg-white/15',
      )}
    >
      <span className={cn('h-5 w-5 rounded-full bg-white shadow transition-transform', checked && 'translate-x-5')} />
    </button>
  );
}

// ── Page header ───────────────────────────────────────────────────────────
/**
 * Standard page chrome: icon + title + subtitle on the left, primary action
 * on the right. Every route uses this so margins and rhythm stay identical.
 */
export function PageHeader({ icon, title, subtitle, actions }: { icon?: ReactNode; title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="flex items-center gap-3">
        {icon && (
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-white/[0.05] text-indigo-300 ring-1 ring-inset ring-white/10">{icon}</div>
        )}
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="text-sm text-slate-500">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

// ── Table ─────────────────────────────────────────────────────────────────
export function Table({ columns, children, className }: { columns: string[]; children: ReactNode; className?: string }) {
  return (
    <div className={cn('overflow-x-auto rounded-xl border border-white/[0.08]', className)}>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-white/[0.08] bg-white/[0.03]">
            {columns.map((c) => (
              <th key={c} className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-slate-400">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-white/[0.05]">{children}</tbody>
      </table>
    </div>
  );
}

// ── Badge ─────────────────────────────────────────────────────────────────
const TONES = {
  neutral: 'bg-white/[0.07] text-slate-300 ring-white/10',
  indigo: 'bg-indigo-500/15 text-indigo-300 ring-indigo-500/20',
  emerald: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/20',
  amber: 'bg-amber-500/15 text-amber-300 ring-amber-500/20',
  rose: 'bg-rose-500/15 text-rose-300 ring-rose-500/20',
  sky: 'bg-sky-500/15 text-sky-300 ring-sky-500/20',
} as const;

export function Badge({ tone = 'neutral', className, children }: { tone?: keyof typeof TONES; className?: string; children: ReactNode }) {
  return <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset', TONES[tone], className)}>{children}</span>;
}

// ── Stat card ─────────────────────────────────────────────────────────────
export function StatCard({ icon, label, value, hint }: { icon?: ReactNode; label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <Card>
      <CardBody className="p-4">
        <div className="flex items-center gap-2 text-slate-400">
          {icon}
          <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
        </div>
        <p className="mt-2 text-2xl font-semibold tabular-nums tracking-tight">{value}</p>
        {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
      </CardBody>
    </Card>
  );
}

// ── Tooltip ───────────────────────────────────────────────────────────────
/** Minimal CSS-only tooltip: wraps children, shows `content` on hover/focus. */
export function Tooltip({ content, children }: { content: string; children: ReactNode }) {
  return (
    <span className="group relative inline-flex">
      {children}
      <span
        role="tooltip"
        className="pointer-events-none absolute -top-2 left-1/2 z-40 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-xs text-slate-200 opacity-0 shadow-lg ring-1 ring-white/10 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {content}
      </span>
    </span>
  );
}

// ── ChipInput — array of strings edited as removable chips ──────────────
/**
 * Compact editor for `string[]` values: env.required, watch.paths,
 * network.aliases. Each value renders as a chip with a remove button; the
 * trailing input adds a new value on Enter, comma, or blur (when the
 * input is non-empty). Whitespace is trimmed and duplicates are dropped so
 * the form state stays canonical without bothering the caller.
 */
export interface ChipInputProps {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  /** Hint shown above the input. */
  hint?: string;
  /** Optional explicit label; defaults to a small uppercase label like other fields. */
  label?: string;
  /** Validation: reject chips that don't match this regex. Invalid chips are simply not added. */
  pattern?: RegExp;
  disabled?: boolean;
}

export function ChipInput({
  value,
  onChange,
  placeholder,
  hint,
  label,
  pattern,
  disabled,
}: ChipInputProps) {
  const [draft, setDraft] = useState('');
  const id = useId();
  const commit = useCallback(
    (raw: string) => {
      const next = raw.trim();
      if (!next) return;
      if (pattern && !pattern.test(next)) {
        setDraft('');
        return;
      }
      if (value.includes(next)) {
        setDraft('');
        return;
      }
      onChange([...value, next]);
      setDraft('');
    },
    [onChange, pattern, value],
  );

  return (
    <div>
      {label && (
        <div className="mb-1.5 flex items-center justify-between">
          <label htmlFor={id} className="block text-xs font-semibold uppercase tracking-wide text-slate-400">
            {label}
          </label>
          {hint && <span className="text-[11px] text-slate-500">{hint}</span>}
        </div>
      )}
      <div
        className={cn(
          'flex flex-wrap items-center gap-1.5 rounded-lg bg-black/30 px-2 py-1.5 text-sm ring-1 ring-inset ring-white/10',
          'focus-within:ring-2 focus-within:ring-indigo-400/60',
          disabled && 'pointer-events-none opacity-50',
        )}
      >
        {value.map((chip) => (
          <span
            key={chip}
            className="inline-flex items-center gap-1 rounded-md bg-indigo-500/15 px-2 py-0.5 text-xs font-medium text-indigo-200 ring-1 ring-inset ring-indigo-500/30"
          >
            {chip}
            <button
              type="button"
              aria-label={`Remove ${chip}`}
              className="rounded-sm p-0.5 text-indigo-300 hover:bg-indigo-500/30 hover:text-indigo-100"
              onClick={() => onChange(value.filter((c) => c !== chip))}
            >
              <X size={11} />
            </button>
          </span>
        ))}
        <input
          id={id}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              commit(draft);
            } else if (e.key === 'Backspace' && draft === '' && value.length > 0) {
              // Convenient: empty draft + backspace removes the last chip.
              onChange(value.slice(0, -1));
            }
          }}
          onBlur={() => commit(draft)}
          placeholder={value.length === 0 ? placeholder : undefined}
          disabled={disabled}
          className="min-w-[8ch] flex-1 bg-transparent px-1 py-0.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none"
        />
      </div>
    </div>
  );
}

// ── KeyValueEditor — object editor for env.aliases, route.headers, ... ──
/**
 * Renders a `Record<string, string>` as a list of editable rows. Each row
 * has key and value inputs plus a delete button; an "Add row" button
 * appends a new empty pair. Empty keys are dropped silently on commit
 * so partial input never poisons the value.
 */
export interface KeyValueEditorProps {
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  addLabel?: string;
  /** Optional key validator; invalid keys are kept in the input but excluded from `onChange`. */
  validateKey?: (key: string) => boolean;
}

export function KeyValueEditor({
  value,
  onChange,
  keyPlaceholder = 'key',
  valuePlaceholder = 'value',
  addLabel = 'Add',
  validateKey,
}: KeyValueEditorProps) {
  const entries = useMemo(() => Object.entries(value), [value]);
  const setRow = (key: string, newKey: string, newValue: string) => {
    const next: Record<string, string> = {};
    for (const [k, v] of entries) {
      if (k === key) {
        if (newKey) next[newKey] = newValue;
      } else {
        next[k] = v;
      }
    }
    onChange(next);
  };
  const deleteRow = (key: string) => {
    const next: Record<string, string> = {};
    for (const [k, v] of entries) if (k !== key) next[k] = v;
    onChange(next);
  };
  const addRow = () => {
    // `Record<string, string>` can hold only ONE empty-key row, so a second
    // "Add" would silently do nothing and the button would look broken.
    // Focus the existing empty row's key input instead — the user clearly
    // wants another row, and the nearest edit point is that one.
    const hadEmpty = '' in value;
    onChange({ ...value, '': '' });
    if (hadEmpty) {
      requestAnimationFrame(() => {
        rootRef.current?.querySelector<HTMLInputElement>('input[aria-label="key (empty)"]')?.focus();
      });
    }
  };
  const rootRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={rootRef} className="space-y-1.5">
      {entries.map(([k, v], i) => (
        // Row index is part of the key so reordering is stable; the value
        // input is identified by `kv-row-{i}-value` for test stability.
        <div key={`${k}:${i}`} className="flex items-center gap-1.5">
          <Input
            aria-label={`key ${k || '(empty)'}`}
            defaultValue={k}
            placeholder={keyPlaceholder}
            className="h-8 flex-1 font-mono text-xs"
            onBlur={(e) => {
              const next = e.target.value.trim();
              if (validateKey && !validateKey(next)) return;
              setRow(k, next, v);
            }}
          />
          <span className="text-slate-500">=</span>
          <Input
            aria-label={`value for ${k || '(empty)'}`}
            defaultValue={v}
            placeholder={valuePlaceholder}
            className="h-8 flex-1 font-mono text-xs"
            onBlur={(e) => setRow(k, k, e.target.value)}
          />
          <button
            type="button"
            aria-label={`Delete ${k || 'row'}`}
            onClick={() => deleteRow(k)}
            className="rounded-md p-1.5 text-slate-400 hover:bg-rose-500/15 hover:text-rose-300"
          >
            <X size={12} />
          </button>
        </div>
      ))}
      <Button type="button" variant="ghost" size="sm" onClick={addRow}>
        <Plus size={12} /> {addLabel}
      </Button>
    </div>
  );
}

// ── ListEditor — array of objects with custom item renderer ──────────────
/**
 * Generic list editor for `T[]` where each item is a complex object
 * (routes, alerts, etc.). The consumer passes `renderItem` to decide how
 * each item looks; the editor owns add / remove / reorder.
 */
export interface ListEditorProps<T> {
  value: T[];
  onChange: (next: T[]) => void;
  /** Builds a fresh item when the user clicks "Add". */
  createNew: () => T;
  /** Renders the body of a single item. The consumer is responsible for any field-level inputs. */
  renderItem: (item: T, update: (next: T) => void, index: number) => ReactNode;
  /** Per-item label shown in the card header. Optional. */
  itemLabel?: (item: T, index: number) => string;
  addLabel?: string;
  emptyMessage?: string;
}

export function ListEditor<T>({
  value,
  onChange,
  createNew,
  renderItem,
  itemLabel,
  addLabel = 'Add',
  emptyMessage = 'No items yet.',
}: ListEditorProps<T>) {
  const setItem = (index: number, next: T) => {
    const copy = value.slice();
    copy[index] = next;
    onChange(copy);
  };
  const removeItem = (index: number) => {
    onChange(value.filter((_, i) => i !== index));
  };
  const moveItem = (index: number, delta: -1 | 1) => {
    // The disabled buttons on the first/last item already block invalid
    // moves through the UI, so this function is only ever called with a
    // valid target. The disabled attribute on the buttons is the gate.
    const target = index + delta;
    const next = value.slice();
    const [moved] = next.splice(index, 1);
    // `moved` is typed `T | undefined` because splice returns it, but
    // the disabled-button gate guarantees `index` is in range here.
    next.splice(target, 0, moved as T);
    onChange(next);
  };
  return (
    <div className="space-y-2">
      {value.length === 0 ? (
        <div className="rounded-lg border border-dashed border-white/10 bg-white/[0.02] px-3 py-4 text-center text-xs text-slate-500">
          {emptyMessage}
        </div>
      ) : (
        value.map((item, i) => (
          <div
            // The index is part of the key so React reuses the card across
            // reorder operations without losing focus.
            key={i}
            className="rounded-lg border border-white/[0.08] bg-white/[0.02] p-3"
          >
            <div className="mb-2 flex items-center justify-between">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                {itemLabel ? `${itemLabel(item, i)}` : `Item ${i + 1}`}
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  aria-label={`Move up`}
                  onClick={() => moveItem(i, -1)}
                  disabled={i === 0}
                  className="rounded-md p-1 text-slate-400 hover:bg-white/10 hover:text-slate-200 disabled:opacity-30"
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`Move down`}
                  onClick={() => moveItem(i, 1)}
                  disabled={i === value.length - 1}
                  className="rounded-md p-1 text-slate-400 hover:bg-white/10 hover:text-slate-200 disabled:opacity-30"
                >
                  ↓
                </button>
                <button
                  type="button"
                  aria-label={`Remove`}
                  onClick={() => removeItem(i)}
                  className="rounded-md p-1 text-slate-400 hover:bg-rose-500/15 hover:text-rose-300"
                >
                  <X size={12} />
                </button>
              </div>
            </div>
            <div>{renderItem(item, (next) => setItem(i, next), i)}</div>
          </div>
        ))
      )}
      <Button type="button" variant="ghost" size="sm" onClick={() => onChange([...value, createNew()])}>
        <Plus size={12} /> {addLabel}
      </Button>
    </div>
  );
}

// ── PresetSelector — single-select preset chooser with preview ───────────
/**
 * Renders a labelled preset picker. When the user picks an option, the
 * consumer receives the parsed `NinedeployManifest` (so it can drop it
 * into the form state). The selector is intentionally stateless — the
 * current selection lives in the form, not the component — so the same
 * preset can be re-applied without re-firing `onSelect`.
 */
export interface PresetOption<T> {
  id: string;
  label: string;
  description?: string;
  manifest: T;
  /** Optional icon rendered to the left of the label. */
  icon?: ReactNode;
  /** Short facts (runtime, port, key command) rendered as tiny chips. */
  meta?: readonly string[];
}

export interface PresetSelectorProps<T> {
  options: readonly PresetOption<T>[];
  onSelect: (manifest: T) => void;
  label?: string;
  hint?: string;
  /** ID of the currently-selected preset, used to highlight the active option. */
  value?: string;
}

export function PresetSelector<T>({ options, onSelect, label, hint, value }: PresetSelectorProps<T>) {
  const id = useId();
  return (
    <div>
      {label && (
        <div className="mb-1.5 flex items-center justify-between">
          <label
            htmlFor={id}
            className="block text-xs font-semibold uppercase tracking-wide text-slate-400"
          >
            {label}
          </label>
          {hint && <span className="text-[11px] text-slate-500">{hint}</span>}
        </div>
      )}
      <div id={id} className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {options.map((opt) => {
          const active = opt.id === value;
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => onSelect(opt.manifest)}
              aria-pressed={active}
              className={cn(
                'rounded-lg border p-3 text-left transition',
                active
                  ? 'border-indigo-500/60 bg-indigo-500/10 ring-1 ring-indigo-500/30'
                  : 'border-white/10 bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.04]',
              )}
            >
              <div className="flex items-center gap-2">
                {opt.icon && (
                  <span className={cn('shrink-0', active ? 'text-indigo-300' : 'text-slate-400')}>
                    {opt.icon}
                  </span>
                )}
                <div className="text-sm font-medium text-slate-100">{opt.label}</div>
              </div>
              {opt.description && (
                <div className="mt-0.5 text-xs text-slate-500">{opt.description}</div>
              )}
              {opt.meta && opt.meta.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {opt.meta.map((chip) => (
                    <span
                      key={chip}
                      className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-slate-400 ring-1 ring-inset ring-white/[0.06]"
                    >
                      {chip}
                    </span>
                  ))}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
