// `npm run build` writes a static site to dist/. For server-rendered pages follow Astro's
// on-demand rendering guide (https://docs.astro.build/en/guides/on-demand-rendering/): install
// an adapter and set `output` to 'server'; the Dockerfile then needs a Node runtime instead of
// the web server it uses now.
import { defineConfig } from 'astro/config';

export default defineConfig({
  output: 'static',
});
