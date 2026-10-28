import { z } from 'zod';

// ── Inline Dockerfile (G1.1) ───────────────────────────────────────────────
// A Dockerfile pasted in the panel instead of kept in the repository. It
// builds with the `dockerfile` pack from the base directory; a docker service
// with neither a repository nor an image builds it from an empty context.

export const INLINE_DOCKERFILE_MAX_BYTES = 64 * 1024;

/** `PUT /v1/services/:id/inline-dockerfile`: the text, or null to build from the repository again. */
export const inlineDockerfileInput = z
  .object({
    content: z
      .string()
      .max(INLINE_DOCKERFILE_MAX_BYTES)
      .refine((v) => /^\s*(#.*\n\s*)*(ARG|FROM)\b/im.test(v), 'A Dockerfile starts with FROM (or ARG before FROM)')
      .nullable(),
  })
  .strict();
export type InlineDockerfileInput = z.infer<typeof inlineDockerfileInput>;

export interface InlineDockerfileView {
  content: string | null;
}
