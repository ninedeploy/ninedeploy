import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { doctorFixRequest } from '@ninedeploy/schemas';
import { audit } from '../lib/audit.js';
import { conflict, unprocessable } from '../lib/errors.js';
import { fixDoctorFinding, scanDoctor } from '../engine/doctor.js';

/**
 * Doctor — one admin surface for "what is wrong on this host and what can I
 * safely do about it". GET answers with a findings report; POST re-scans and
 * executes one finding's repair. Every fix re-locates its target against
 * fresh state inside the engine (see {@link fixDoctorFinding}), so a stale
 * panel can never drive a destructive action at something that stopped
 * qualifying — it gets a 409 instead.
 */
export const doctorRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.addHook('onRequest', app.authenticate);
  app.addHook('preHandler', app.requireAdmin);

  app.get('/', async () => {
    return scanDoctor(app.db);
  });

  app.post('/fix', async (req) => {
    const parsed = doctorFixRequest.safeParse(req.body);
    if (!parsed.success) {
      throw unprocessable(parsed.error.issues[0]!.message);
    }
    const result = await fixDoctorFinding(app.db, parsed.data.findingId, (line) =>
      app.log.info({ component: 'doctor' }, line),
    );
    if (!result) {
      throw conflict('Finding is no longer present — the state moved on or was already fixed. Re-scan and retry.');
    }
    void audit(app.db, req.user!.id, 'doctor.fix', `${result.action}: ${result.id}`);
    return { ...result, report: await scanDoctor(app.db) };
  });
};
