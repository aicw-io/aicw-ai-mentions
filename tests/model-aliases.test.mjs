import test from 'node:test';
import assert from 'node:assert/strict';

import { getModelById } from '../dist/ai-preset-manager.js';

test('public latest chat aliases resolve to current OpenRouter model slugs', () => {
  assert.equal(getModelById('openai_chatgpt_with_search_latest')?.model, 'openai/gpt-chat-latest');
  assert.equal(getModelById('anthropic_claude_with_search_latest')?.model, '~anthropic/claude-sonnet-latest');
  assert.equal(getModelById('perplexity_with_search_latest')?.model, 'perplexity/sonar-pro-search');
  assert.equal(getModelById('x_ai_grok_with_search_latest')?.model, 'x-ai/grok-4.3');
  assert.equal(getModelById('grok_with_search_latest')?.model, 'x-ai/grok-4.3');
});
