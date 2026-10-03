import { createContext, useContext, useState, type ReactNode } from 'react';

export type ExperienceMode = 'simple' | 'advanced';

interface ModeContextType {
  mode: ExperienceMode;
  isAdvanced: boolean;
  isSimple: boolean;
  setMode: (mode: ExperienceMode) => void;
  toggleMode: () => void;
}

const ModeContext = createContext<ModeContextType | null>(null);

const STORAGE_KEY = 'ninedeploy_experience_mode';

export function ModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ExperienceMode>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === 'simple' || saved === 'advanced') return saved;
    } catch {
      // ignore
    }
    return 'simple';
  });

  const setMode = (newMode: ExperienceMode) => {
    setModeState(newMode);
    try {
      localStorage.setItem(STORAGE_KEY, newMode);
    } catch {
      // ignore
    }
  };

  const toggleMode = () => {
    setMode(mode === 'simple' ? 'advanced' : 'simple');
  };

  return (
    <ModeContext.Provider
      value={{
        mode,
        isAdvanced: mode === 'advanced',
        isSimple: mode === 'simple',
        setMode,
        toggleMode,
      }}
    >
      {children}
    </ModeContext.Provider>
  );
}

export function useExperienceMode(): ModeContextType {
  const ctx = useContext(ModeContext);
  if (!ctx) {
    return {
      mode: 'simple',
      isAdvanced: false,
      isSimple: true,
      setMode: () => {},
      toggleMode: () => {},
    };
  }
  return ctx;
}
