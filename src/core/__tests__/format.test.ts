import { describe, it, expect } from 'vitest';
import { FORMAT_VERSION } from '../format';

describe('FORMAT_VERSION', () => {
  it('is 1, the version every shareable URL carries', () => {
    // SPEC §4.5 names the value, not merely its existence: a build that served
    // `v2` fragments against this format's text would hand out links that no
    // later build could honour, and nothing downstream would notice.
    expect(FORMAT_VERSION).toBe(1);
  });
});
