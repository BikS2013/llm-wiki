import test from 'node:test';
import assert from 'node:assert/strict';
import { Config, parseDotenv } from '../src/config/env.js';
import { chatSettings, embeddingSettings, parseProvider } from '../src/config/settings.js';
import { ConfigError } from '../src/errors.js';

test('parseDotenv handles export, quotes and comments', () => {
  const env = parseDotenv('# c\nexport A=1\nB="two words" \nC=\'x\'\nD=val # trailing\nbad line\n');
  assert.deepEqual(env, { A: '1', B: 'two words', C: 'x', D: 'val' });
});

test('Config.require throws a ConfigError instead of defaulting', () => {
  const cfg = Config.fromValues({ LLM_WIKI_PROVIDER: 'openai' });
  assert.throws(() => cfg.require('LLM_WIKI_MODEL'), ConfigError);
  assert.throws(() => chatSettings(cfg), /LLM_WIKI_MODEL/);
  assert.equal(cfg.requireAny(['GEMINI_API_KEY', 'LLM_WIKI_PROVIDER']), 'openai');
});

test('CLI overrides win over lower tiers and describe masks secrets', () => {
  const prev = process.env.LLM_WIKI_MODEL;
  process.env.LLM_WIKI_MODEL = 'from-shell';
  try {
    const cfg = Config.load({ LLM_WIKI_MODEL: 'from-cli', OPENAI_API_KEY: 'sk-1234567890abcdef' }, '/nonexistent-cwd');
    assert.equal(cfg.get('LLM_WIKI_MODEL'), 'from-cli');
    assert.equal(cfg.source('LLM_WIKI_MODEL'), 'cli');
    const row = cfg.describe((n) => n === 'OPENAI_API_KEY')[0];
    assert.equal(row?.value, 'sk-1…cdef');
  } finally {
    if (prev === undefined) delete process.env.LLM_WIKI_MODEL;
    else process.env.LLM_WIKI_MODEL = prev;
  }
});

test('provider validation and embedding rules', () => {
  assert.equal(parseProvider('Azure-OpenAI', 'X'), 'azure-openai');
  assert.throws(() => parseProvider('bedrock', 'X'), /not a supported provider/);
  assert.throws(() => embeddingSettings(Config.fromValues({ LLM_WIKI_EMBEDDING_PROVIDER: 'anthropic', LLM_WIKI_EMBEDDING_MODEL: 'x' })), /do not produce embeddings/);
  assert.equal(chatSettings(Config.fromValues({ LLM_WIKI_PROVIDER: 'azure-openai', AZURE_OPENAI_DEPLOYMENT: 'gpt-dep' })).model, 'gpt-dep');
});
