import { useEffect, useState } from 'react';

/** Below Tailwind's `md` breakpoint: the side menu becomes a drawer. */
export const NARROW_QUERY = '(max-width: 767px)';

function matches(query: string): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
}

/** Whether `query` matches now, kept current as the viewport changes (false where matchMedia is missing). */
export function useMediaQuery(query: string): boolean {
  const [value, setValue] = useState(() => matches(query));
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(query);
    const onChange = () => setValue(list.matches);
    onChange();
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  return value;
}
