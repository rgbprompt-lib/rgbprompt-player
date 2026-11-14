import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

// SHA-256 of the files as they existed in packages/engine/data/boards before
// the move. Any content change breaks the byte-identical guarantee.
const EXPECTED: Record<string, string> = {
  'ansi104.cells.json': '127943681f6cc2695cc886b21c3627630459d85772c7ce68642b26e78a772f52',
  'ansi104.kle.json': '7e6c4dc23567cb50ce81918d62a62f1022472a0f1d165201c4af22416a3ab6e5',
  'ansi104.regions-v1.json': '817165ee160f35e5bc83bbfffafe1297663cfcd0e26e8ab2981383749e2e9fc8',
  'ansi104.regions-v2.json': 'b96df07e9f23f43f0c54c24d7779316337346a8d1ee65e4e5ece042383f4cac1',
  'generic.json': '194ac4ac784e685789af6387255e1b2ea080c51ea46d236ebe2be784df23744c',
  'k60.kle.json': 'c7dd449764c1212f7d0e3b53d6d5220e5352ae838077257589307df828d1cf53',
  'k65.kle.json': 'f8ba4f0cb9c74f39a7e42fb35e8aa29a68ceb324a658df987a60223c603d0c2a',
  'k75.kle.json': '91720bf162610d70ba32c47140c50875aaf8aeef6c0f14d94b3144e4cbb87a69',
  'tkl87.kle.json': '6bbac456463f455c1c54fc4a2df66ed3678505363454413c7ab9fecfb905895e',
};

describe('layout data files', () => {
  for (const [name, hash] of Object.entries(EXPECTED)) {
    it(`${name} is byte-identical to the moved engine copy`, () => {
      const bytes = readFileSync(new URL(`../data/${name}`, import.meta.url));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(hash);
    });
  }
});
