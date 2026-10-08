/** Infinite horizontal marquee — used for the template hub strip. */
export function Marquee({ items }: { items: string[] }) {
  return (
    <div className="relative overflow-hidden border-y-2 border-edge dark:border-line bg-ink dark:bg-panel py-3">
      <div className="flex w-max animate-marquee gap-10 pr-10 hover:[animation-play-state:paused]">
        {items.map((item) => (
          <MarqueeItem key={item} item={item} />
        ))}
        {items.map((item) => (
          <MarqueeItem key={`dup-${item}`} item={item} />
        ))}
      </div>
    </div>
  );
}

function MarqueeItem({ item }: { item: string }) {
  return (
    <span className="font-mono text-sm text-zinc-400 dark:text-zinc-500 whitespace-nowrap flex items-center gap-10">
      {item}
      <span className="text-phosphor-dim">✦</span>
    </span>
  );
}
