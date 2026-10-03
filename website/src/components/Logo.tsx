/**
 * Brand mark: navy hexagon terminal bubble.
 * Layered like the reference — gradient shell, teal rim light, traffic-light
 * titlebar, prompt gutter and the 2×2 teal panes with a gloss sweep.
 * Colors are the brand tokens (void/ink/line navy, phosphor teal family).
 */
export function Logo({ className = "w-8 h-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
      <defs>
        {/* shell: subtle top-light navy gradient */}
        <linearGradient id="nd-logo-shell" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2A3B52" />
          <stop offset="1" stopColor="#16202E" />
        </linearGradient>
        {/* pane gloss: brighter at the top-left */}
        <linearGradient id="nd-logo-gloss" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7CE4DC" />
          <stop offset="1" stopColor="#4ECDC4" />
        </linearGradient>
        <linearGradient id="nd-logo-gloss-dim" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4ECDC4" />
          <stop offset="1" stopColor="#17948A" />
        </linearGradient>
      </defs>

      {/* hexagon shell */}
      <polygon
        points="24,3 43,14 43,34 24,45 5,34 5,14"
        fill="url(#nd-logo-shell)"
        stroke="#16202E"
        strokeWidth="3.5"
        strokeLinejoin="round"
      />
      {/* teal rim light along the top-left edges */}
      <path
        d="M24 4.4 41.8 14.6 M24 4.4 6.2 14.6"
        fill="none"
        stroke="#4ECDC4"
        strokeWidth="1.4"
        strokeLinecap="round"
        opacity="0.55"
      />
      {/* speech-bubble tail */}
      <path
        d="M8 37 q-2.5 5.5 5 5.5"
        fill="none"
        strokeWidth="3"
        strokeLinecap="round"
        className="[stroke:#dbe4ee] dark:[stroke:#16202E]"
      />

      {/* terminal window */}
      <rect x="11" y="12" width="26" height="22" rx="3.5" fill="#FFFFFF" />
      {/* titlebar with traffic lights */}
      <path
        d="M11 15.5 A3.5 3.5 0 0 1 14.5 12 H33.5 A3.5 3.5 0 0 1 37 15.5 V17.5 H11 Z"
        fill="#1E2A3A"
      />
      <circle cx="14.6" cy="14.8" r="1.15" fill="#FF5C87" />
      <circle cx="18.1" cy="14.8" r="1.15" fill="#FFB454" />
      <circle cx="21.6" cy="14.8" r="1.15" fill="#4ECDC4" />
      {/* prompt gutter line */}
      <rect x="13.5" y="20" width="2.2" height="11" rx="1.1" fill="#22324E" opacity="0.85" />

      {/* 2×2 panes — diagonal teal gradient + gloss */}
      <rect x="17.8" y="20" width="8.1" height="4.9" rx="1.3" fill="url(#nd-logo-gloss)" />
      <rect x="27.6" y="20" width="8.1" height="4.9" rx="1.3" fill="url(#nd-logo-gloss-dim)" />
      <rect x="17.8" y="26.2" width="8.1" height="4.9" rx="1.3" fill="url(#nd-logo-gloss-dim)" />
      <rect x="27.6" y="26.2" width="8.1" height="4.9" rx="1.3" fill="url(#nd-logo-gloss)" />
    </svg>
  );
}
