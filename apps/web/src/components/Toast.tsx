import { type ReactNode, createContext, useContext, useState, useCallback } from 'react';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { cn } from './ui.js';

type ToastType = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
}

interface ToastContextValue {
  toast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const STYLES: Record<ToastType, string> = {
  success: 'border-emerald-500/30 bg-emerald-500/[0.08] text-emerald-200',
  error: 'border-rose-500/30 bg-rose-500/[0.08] text-rose-200',
  info: 'border-indigo-500/30 bg-indigo-500/[0.08] text-indigo-200',
};

const ICONS: Record<ToastType, typeof CheckCircle2> = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (message: string, type: ToastType = 'info') => {
      const id = Date.now() + Math.random();
      setItems((prev) => [...prev, { id, message, type }]);
      setTimeout(() => dismiss(id), 4000);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      {/* Toaster — aria-live so screen readers announce failures/updates */}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2"
      >
        {items.map((item) => {
          const Icon = ICONS[item.type];
          return (
            <div
              key={item.id}
              className={cn(
                'nd-fade pointer-events-auto flex items-center gap-2.5 rounded-xl border px-3.5 py-2.5 shadow-lg backdrop-blur',
                STYLES[item.type],
              )}
            >
              <Icon size={16} className="shrink-0" />
              <span className="flex-1 text-sm font-medium">{item.message}</span>
              <button type="button"
                onClick={() => dismiss(item.id)}
                className="shrink-0 rounded p-0.5 opacity-50 transition hover:opacity-100"
              >
                <X size={13} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

const fallbackToastContext: ToastContextValue = {
  // Defensive no-op: every test tree mounts a ToastProvider, so the fallback
  // toast body never runs under coverage.
  /* v8 ignore next 1 */
  toast: () => {},
};

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  return ctx ?? fallbackToastContext;
}
