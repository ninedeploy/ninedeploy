import { describe, expect, it } from 'vitest';
import { AI_PROVIDERS, aiConfig, aiConfigUpdate, ANTHROPIC_DEFAULT_BASE_URL } from '../src/ai.js';

/** 0.16.15: the provider field; openai still needs a base URL, Claude does not. */
describe('AI provider configuration', () => {
  it('reads a configuration without a provider as before', () => {
    expect(aiConfig.parse({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' })).toEqual({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' });
    expect(aiConfig.safeParse({ model: 'gpt-4o-mini' }).success).toBe(false);
  });

  it('accepts Claude with or without a base URL', () => {
    expect(aiConfig.safeParse({ provider: 'anthropic', model: 'claude-sonnet-5-5' }).success).toBe(true);
    expect(aiConfig.safeParse({ provider: 'anthropic', baseUrl: ANTHROPIC_DEFAULT_BASE_URL, model: 'claude-sonnet-5-5' }).success).toBe(true);
    expect(AI_PROVIDERS).toEqual(['openai', 'anthropic']);
  });

  it('names the base URL when openai has none, for the update body too', () => {
    const res = aiConfigUpdate.safeParse({ provider: 'openai', model: 'm', apiKey: 'sk-12345678' });
    expect(res.success).toBe(false);
    expect(res.error?.issues[0]?.path).toEqual(['baseUrl']);
    expect(aiConfigUpdate.safeParse({ provider: 'nope', model: 'm' }).success).toBe(false);
    expect(aiConfigUpdate.safeParse({ model: 'm' }).success).toBe(false);
    expect(aiConfigUpdate.safeParse({ provider: 'anthropic', model: 'm' }).success).toBe(true);
  });
});
