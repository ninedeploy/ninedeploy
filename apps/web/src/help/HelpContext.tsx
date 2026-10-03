import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

interface HelpContextValue {
  /** Whether the help drawer is currently visible. */
  open: boolean;
  /**
   * Explicit topic requested via openHelp(id), or null to follow the page
   * the user is currently on.
   */
  topicId: string | null;
  /** Open the drawer, optionally on a specific topic instead of the current page. */
  openHelp: (topicId?: string) => void;
  closeHelp: () => void;
}

const HelpContext = createContext<HelpContextValue | null>(null);

/**
 * State owner for the help drawer. It lives above the layout so the header
 * button, the drawer and any future in-page "learn more" links share one
 * open state.
 */
export function HelpProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [topicId, setTopicId] = useState<string | null>(null);

  const openHelp = useCallback((id?: string) => {
    setTopicId(id ?? null);
    setOpen(true);
  }, []);
  const closeHelp = useCallback(() => setOpen(false), []);

  const value = useMemo(
    () => ({ open, topicId, openHelp, closeHelp }),
    [open, topicId, openHelp, closeHelp],
  );

  return <HelpContext.Provider value={value}>{children}</HelpContext.Provider>;
}

export function useHelp(): HelpContextValue {
  const ctx = useContext(HelpContext);
  if (!ctx) throw new Error('useHelp must be used inside <HelpProvider>');
  return ctx;
}
