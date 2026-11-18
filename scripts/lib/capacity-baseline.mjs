export const profile = Object.freeze({
  services: 12,
  nodes: 2,
  warmupSeconds: 10,
  steadySeconds: 60,
  requestsPerSecond: 8,
  routes: ['/v1/services', '/v1/servers', '/v1/services/queue', '/v1/activity?limit=25'],
  deploymentBursts: [5, 30],
  deploymentsPerBurst: 3,
  logBursts: [10, 25, 40],
  linesPerBurst: 400,
  settleMs: 45_000,
});

export const limits = Object.freeze({
  routeP95Ms: 350,
  requestFailures: 0,
  launchP95Ms: 250,
  panelLoopWindowP95Ms: 100,
  panelLoopWindows: 50,
  sqliteBusyLines: 0,
  storageGrowthBytes: 24 * 1024 * 1024,
  deploymentWaitP95Ms: 25_000,
  logPendingEntries: 1_200,
  logFinalPendingEntries: 0,
  logMissingLines: 0,
  logDuplicateLines: 0,
  panelRestartMs: 30_000,
});

export function nearestRankP95(samples) {
  if (!samples.length || samples.some(value => !Number.isFinite(value) || value < 0)) return null;
  const sorted = samples.toSorted((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

export function capacityChecks(metrics) {
  const atMost = (name, value, limit) => ({ name, value, limit, passed: Number.isFinite(value) && value <= limit });
  const exact = (name, value, limit) => ({ name, value, limit, passed: value === limit });
  const callsPerRoute = profile.steadySeconds * profile.requestsPerSecond / profile.routes.length;
  return [
    ...profile.routes.flatMap(route => [
      exact(`${route} samples`, metrics.routes[route]?.count ?? 0, callsPerRoute),
      atMost(`${route} p95 ms`, metrics.routes[route]?.p95Ms ?? null, limits.routeP95Ms),
    ]),
    atMost('HTTP failures', metrics.requestFailures, limits.requestFailures),
    atMost('Load driver launch p95 ms', metrics.launchP95Ms, limits.launchP95Ms),
    { name: 'Panel event-loop samples', value: metrics.panelLoopWindows, limit: limits.panelLoopWindows,
      passed: metrics.panelLoopWindows >= limits.panelLoopWindows },
    atMost('Worst one-second panel event-loop p95 ms', metrics.panelLoopWindowP95Ms, limits.panelLoopWindowP95Ms),
    atMost('SQLite busy log lines', metrics.sqliteBusyLines, limits.sqliteBusyLines),
    atMost('Panel volume growth bytes', metrics.storageGrowthBytes, limits.storageGrowthBytes),
    exact('Completed deployments', metrics.deploymentsCompleted, profile.deploymentBursts.length * profile.deploymentsPerBurst),
    atMost('Deployment queue wait p95 ms', metrics.deploymentWaitP95Ms, limits.deploymentWaitP95Ms),
    atMost('Peak sampled pending log entries', metrics.logPendingEntries, limits.logPendingEntries),
    exact('Final pending log entries', metrics.logFinalPendingEntries, limits.logFinalPendingEntries),
    exact('Missing log lines', metrics.logMissingLines, limits.logMissingLines),
    exact('Duplicate log lines', metrics.logDuplicateLines, limits.logDuplicateLines),
    atMost('Panel restart to usable API ms', metrics.panelRestartMs, limits.panelRestartMs),
  ];
}
