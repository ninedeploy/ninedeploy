import type { FastifyPluginAsync } from 'fastify';
import { inlineDockerfileInput, type InlineDockerfileView } from '@ninedeploy/schemas';
import { audit } from '../lib/audit.js';
import { badRequest, parseId } from '../lib/errors.js';
import { getInlineDockerfile, setInlineDockerfile } from '../lib/inlineDockerfile.js';
import { assertServiceRole, loadServiceForUser } from '../lib/resourceAccess.js';

/**
 * G1.1 inline Dockerfile: `GET/PUT /v1/services/:id/inline-dockerfile`, a
 * build setting (`member`), applied on the next deploy. Docker services that
 * build from source: a repository, an upload, or nothing at all.
 */
export const inlineDockerfileRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/:id/inline-dockerfile', async (req): Promise<InlineDockerfileView> => {
    const svc = await loadServiceForUser(app.db, parseId((req.params as { id: string }).id), req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    return { content: await getInlineDockerfile(app.db, svc.id) };
  });

  app.put('/:id/inline-dockerfile', async (req): Promise<InlineDockerfileView> => {
    const svc = await loadServiceForUser(app.db, parseId((req.params as { id: string }).id), req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    const { content } = inlineDockerfileInput.parse(req.body ?? {});
    if (content !== null && (svc.type !== 'docker' || svc.image || svc.composeContent)) {
      throw badRequest('An inline Dockerfile is for docker services that build from source, not from an image or a compose file', 'inline_dockerfile_unsupported');
    }
    await setInlineDockerfile(app.db, svc.id, content);
    void audit(app.db, req.user!.id, content ? 'service.inline_dockerfile.set' : 'service.inline_dockerfile.clear', `${svc.name} #${svc.id}`, {
      serviceId: svc.id,
      ...(content && { bytes: Buffer.byteLength(content) }),
    });
    return { content: await getInlineDockerfile(app.db, svc.id) };
  });
};
