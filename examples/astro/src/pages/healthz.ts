// A static endpoint: `astro build` writes its answer to dist/healthz, which the web server
// serves as it is. It is the health check the deployment waits for (.ninedeploy: run.healthcheck).
export const prerender = true;

export const GET = () => new Response(JSON.stringify({ status: 'ok' }), {
  headers: { 'content-type': 'application/json' },
});
