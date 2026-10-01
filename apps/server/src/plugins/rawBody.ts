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
        try {
          done(null, JSON.parse(body.toString()));
        } catch (err) {
          done(err as Error, undefined);
        }
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
