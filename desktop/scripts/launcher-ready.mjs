/** A CDP page target exists before its preload and document are ready. */
export async function waitForLauncher(readState, { attempts = 20, pause = () => new Promise((resolve) => setTimeout(resolve, 500)) } = {}) {
  let state = null;
  for (let i = 0; i < attempts; i++) {
    state = await readState();
    if (state?.form && state.bridge === 'object' && state.node === 'undefined') return state;
    if (i + 1 < attempts) await pause();
  }
  throw new Error(`unexpected launcher state ${JSON.stringify(state)}`);
}
