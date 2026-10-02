import fp from 'fastify-plugin';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

/**
 * Capture the raw request body for `application/json` so webhook handlers can
 * verify HMAC signatures over the exact bytes the provider sent. The parsed
 * JSON is still exposed on `req.body` as usual.
 */
export default fp(
  async (fastify) => {
    // r506: replacing Fastify's JSON parser with a bare JSON.parse dropped its
    // prototype-poisoning guard — `{"__proto__":{…}}` and
    // `{"constructor":{"prototype":{…}}}` reached every handler that spreads or
    // merges req.body. Delegate to Fastify's own parser (secure-json-parse
    // under the hood, no extra dependency) with its default 'error' actions,
    // so a poisoned body is a 400 exactly as it is without this plugin.
    const secureJsonParse = fastify.getDefaultJsonParser('error', 'error');
    fastify.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (req, body, done) => {
        req.rawBody = body as Buffer;
        // r477: an EMPTY body declared as JSON is a request plenty of real
        // clients make (fetch wrappers that always set content-type on
        // DELETEs). Fastify's own parser treats it as {}; the journey smoke
        // caught this returning 500 via JSON.parse('') — mirror the default.
        if (body.length === 0) {
          done(null, {});
          return;
        }
        secureJsonParse(req, body.toString(), done);
      },
    );

    // Allow binary uploads (e.g. system import tar.gz).
    fastify.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer' },
      (_req, body, done) => {
        done(null, body.toString('binary'));
      },
    );
  },
  { name: 'ninedeploy-rawbody' },
);
