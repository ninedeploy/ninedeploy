/** Resolve by role, not tag equality: local candidates can report the same version. */
export function resolveSmokeImage(role, { from, to, fromImage, toImage }) {
  const override = role === 'from' ? fromImage : toImage;
  const tag = role === 'from' ? from : to;
  return override || `ghcr.io/ninedeploy/ninedeploy:${tag}`;
}
