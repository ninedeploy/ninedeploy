export function Sparkline({
  points,
  color = '#818cf8',
  height = 36,
  width = 140,
}: {
  points: number[];
  color?: string;
  height?: number;
  width?: number;
}) {
  if (points.length < 2) {
    return (
      <svg width={width} height={height} className="opacity-40">
        <title>Trend</title>
        <line x1="0" y1={height - 1} x2={width} y2={height - 1} stroke={color} strokeWidth="1" />
      </svg>
    );
  }
  const max = Math.max(...points);
  const min = Math.min(...points);
  const range = max - min || 1;
  const step = width / (points.length - 1);
  const coords: Array<[number, number]> = points.map((p, i): [number, number] => [
    i * step,
    height - ((p - min) / range) * (height - 2) - 1,
  ]);
  const line = coords.map((c, i) => `${i ? 'L' : 'M'}${c[0].toFixed(1)} ${c[1].toFixed(1)}`).join(' ');
  const area = `${line} L ${width} ${height} L 0 ${height} Z`;

  return (
    <svg width={width} height={height} className="overflow-visible">
      <title>Trend</title>
      <path d={area} fill={color} opacity="0.12" />
      <path d={line} stroke={color} strokeWidth="1.5" fill="none" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
