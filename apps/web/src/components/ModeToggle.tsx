import { useExperienceMode } from '../lib/mode.js';
import { Sparkles, Terminal } from 'lucide-react';
import { cn } from './ui.js';

export function ModeToggle({ className }: { className?: string }) {
  const { isAdvanced, toggleMode } = useExperienceMode();

  return (
    <button
      type="button"
      onClick={toggleMode}
      title={isAdvanced ? 'Switch to Simple Guided View' : 'Switch to Advanced DevOps Pro View'}
      className={cn(
        'relative inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-all duration-300 border shadow-xs select-none',
        isAdvanced
          ? 'bg-amber-500/10 border-amber-500/30 text-amber-300 hover:bg-amber-500/20 hover:border-amber-500/50 shadow-amber-500/10'
          : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/20 hover:border-emerald-500/50 shadow-emerald-500/10',
        className,
      )}
    >
      {isAdvanced ? (
        <>
          <Terminal className="w-3.5 h-3.5 text-amber-400 animate-pulse" />
          <span className="font-mono font-semibold">DevOps Pro</span>
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-ping" />
        </>
      ) : (
        <>
          <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
          <span className="font-semibold">Simple View</span>
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400" />
        </>
      )}
    </button>
  );
}
