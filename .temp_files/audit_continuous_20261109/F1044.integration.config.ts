import base from './vitest.config.js';
export default { ...base, test: { ...base.test, include: ['apps/server/test/integration/containerProbeHttp.test.ts'] } };
