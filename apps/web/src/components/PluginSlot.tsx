import { Link } from 'react-router';
import { ExternalLink, Puzzle } from 'lucide-react';
import { menuTarget, usePluginMenus } from '../lib/pluginMenus.js';

export interface PluginSlotProps {
  slot:
    | 'sidebar:main'
    | 'sidebar:secondary'
    | 'service:tabs'
    | 'database:tabs'
    | 'settings:nav'
    | 'command:palette'
    | 'user:menu'
    | 'dashboard:overview'
    | 'service:overview:widget'
    | 'monitoring:widgets'
    | string;
  className?: string;
}

export function PluginSlot({ slot, className = '' }: PluginSlotProps) {
  // r566: the shared, typed menus query — filtered here, not cached per slot.
  const menusQuery = usePluginMenus();
  const items = (menusQuery.data ?? []).filter((item) => item.slot === slot);

  if (items.length === 0) {
    return null;
  }

  return (
    <div className={`plugin-slot plugin-slot-${slot.replace(/:/g, '-')} ${className}`}>
      {items.map((item) => {
        // r566: an unsafe route (javascript:, data:, //host, …) renders no link.
        const target = menuTarget(item.route);

        return (
          <div
            // F921: since F896 two plugins may each own an item with the same
            // id — key by (pluginId, id), the registry's own identity.
            key={JSON.stringify([item.pluginId ?? null, item.id])}
            className="flex items-center justify-between p-3.5 rounded-lg border border-slate-700/60 bg-slate-800/40 hover:bg-slate-800/80 transition-colors"
          >
            <div className="flex items-center gap-3">
              <div className="p-2 rounded bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                <Puzzle size={16} />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-slate-200">{item.label}</span>
                  {item.badge && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300 font-mono">
                      {typeof item.badge === 'object' ? item.badge.text : item.badge}
                    </span>
                  )}
                </div>
                {item.description && (
                  <p className="text-xs text-slate-400 mt-0.5">{item.description}</p>
                )}
              </div>
            </div>

            {target?.kind === 'external' && (
              <a
                href={target.href}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
              >
                Open <ExternalLink size={12} />
              </a>
            )}
            {target?.kind === 'internal' && (
              <Link
                to={target.to}
                className="flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
              >
                View
              </Link>
            )}
          </div>
        );
      })}
    </div>
  );
}
