import test from 'node:test';
import assert from 'node:assert/strict';

import { isValidLink, validateLinkReachability } from '../dist/utils/validate-links.js';

test('validates link syntax before reachability checks', () => {
  assert.equal(isValidLink('aicw.ai/ai-mentions'), true);
  assert.equal(isValidLink('https://aicw.io/aicw-ai-mentions'), true);
  assert.equal(isValidLink('not-a-link'), false);
  assert.equal(isValidLink('https://no-dot'), false);
});

test('can run syntax-only link verification without network', async () => {
  assert.deepEqual(await validateLinkReachability('aicw.ai/ai-mentions', {
    checkReachability: false
  }), {
    link: 'aicw.ai/ai-mentions',
    valid: true
  });
});
