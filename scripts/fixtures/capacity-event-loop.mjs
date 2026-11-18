import { appendFileSync } from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const histogram = monitorEventLoopDelay({ resolution: 10 });
histogram.enable();
setInterval(() => {
  const sample = { at: Date.now(), count: histogram.count, p95Ms: histogram.percentile(95) / 1e6 };
  appendFileSync('/tmp/n06-event-loop.ndjson', `${JSON.stringify(sample)}\n`);
  histogram.reset();
}, 1000).unref();
