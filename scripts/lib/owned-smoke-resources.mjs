/** Remove only an explicitly labelled resource captured from this Docker daemon. */
export function inspectOwnedSmokeResource(run, kind, name, owner) {
  if (!['container', 'network', 'volume'].includes(kind) || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) || !/^[a-f0-9]{32}$/.test(owner)) {
    throw new Error('Invalid smoke resource identity');
  }
  const format = kind === 'container' ? '{{.Id}}|{{index .Config.Labels "ninedeploy.proof"}}'
    : kind === 'network' ? '{{.Id}}|{{index .Labels "ninedeploy.proof"}}' : '{{.Name}}|{{index .Labels "ninedeploy.proof"}}';
  const inspected = run([kind, 'inspect', name, '--format', format]);
  if (inspected.status !== 0) return { status: 'unavailable' };
  const pieces = (inspected.stdout ?? '').trim().split('|');
  if (pieces.length !== 2 || pieces[1] !== owner || (kind === 'volume' ? pieces[0] !== name : !/^[a-f0-9]{64}$/.test(pieces[0]))) return { status: 'foreign' };
  return { status: 'owned', id: pieces[0] };
}

export function removeOwnedSmokeResource(run, kind, name, owner) {
  const identity = inspectOwnedSmokeResource(run, kind, name, owner);
  if (identity.status !== 'owned') return identity.status;
  const removed = run(kind === 'container' ? ['rm', '-f', identity.id] : [kind, 'rm', identity.id]);
  return removed.status === 0 ? 'removed' : 'unavailable';
}
