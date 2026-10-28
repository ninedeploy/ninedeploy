import { z } from 'zod';

// ── Forward auth: put any app behind panel sign-in (G2.3) ──────────────────
// Per domain, off by default. Traefik asks the panel about every request; a
// visitor without a valid cookie for that domain signs in on the panel and
// comes back with one. Only users with at least `minRole` on the service get in.

export const forwardAuthConfig = z
  .object({
    /** The least role on the service a visitor needs. */
    minRole: z.enum(['viewer', 'member', 'admin', 'owner']).default('viewer'),
  })
  .strict();
export type ForwardAuthConfig = z.infer<typeof forwardAuthConfig>;

/** `PUT /v1/domains/:id/forward-auth`: a config turns it on, null turns it off. */
export const forwardAuthInput = z.object({ forwardAuth: forwardAuthConfig.nullable() }).strict();
export type ForwardAuthInput = z.input<typeof forwardAuthInput>;

export interface ForwardAuthView {
  domainId: number;
  forwardAuth: ForwardAuthConfig | null;
}

/** `POST /v1/forward-auth/grant`: the signed-in user asks to enter a protected domain. */
export const forwardAuthGrantInput = z
  .object({
    domainId: z.number().int().positive(),
    /** Where to land afterwards: a URL on that domain. */
    returnTo: z.string().url().max(2048),
    /** The `state` the domain set as a cookie before sending the browser here. */
    state: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  })
  .strict();
export type ForwardAuthGrantInput = z.infer<typeof forwardAuthGrantInput>;

export interface ForwardAuthGrant {
  /** Open this URL: it sets the domain's cookie and goes on to `returnTo`. */
  url: string;
}
