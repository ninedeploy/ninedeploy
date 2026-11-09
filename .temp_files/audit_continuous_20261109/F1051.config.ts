import { fileURLToPath } from 'node:url';
import base from './vitest.config.js';
export default {
  ...base,
  resolve: { alias: [
    ...base.resolve!.alias as Array<{ find: RegExp; replacement: string }>,
    { find: /^croner$/, replacement: fileURLToPath(new URL('../../apps/server/node_modules/croner/dist/croner.js', import.meta.url)) },
  ] },
};
