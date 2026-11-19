import assert from 'node:assert/strict';
import { closeSync, openSync, statfsSync, unlinkSync, writeSync } from 'node:fs';

const mode = process.argv[2];
const maxBytes = 32 * 1024 * 1024;
const prefix = '/data/.n06-filler';
const usage = () => {
  const state = statfsSync('/data');
  assert.equal(state.type, 0x01021994, 'The probe requires the dedicated tmpfs volume');
  assert.equal(state.blocks * state.bsize, maxBytes, 'The tmpfs volume must have the fixture size');
  return { totalBytes: state.blocks * state.bsize, freeBytes: state.bavail * state.bsize };
};

if (mode === 'release') {
  usage();
  unlinkSync(prefix);
  console.log(JSON.stringify(usage()));
} else {
  assert.equal(mode, 'fill');
  const before = usage();
  assert.ok(before.freeBytes > maxBytes / 2, 'The test volume must start mostly empty');
  const block = Buffer.alloc(64 * 1024, 1);
  const fd = openSync(prefix, 'wx');
  let full = false;
  let recorded = false;
  try {
    for (let written = 0; written <= maxBytes;) {
      try {
        const count = writeSync(fd, block);
        assert.ok(count > 0);
        written += count;
      } catch (error) {
        if (error.code !== 'ENOSPC') throw error;
        full = true;
        break;
      }
    }
    const after = usage();
    assert.ok(full && after.freeBytes === 0, 'The bounded write did not prove a full filesystem');
    console.log(JSON.stringify({ before, after, errno: 'ENOSPC' }));
    recorded = true;
  } finally {
    closeSync(fd);
    if (!recorded) unlinkSync(prefix);
  }
}
