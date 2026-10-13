import path from 'node:path';
import type { Config } from './env.js';
import { ConfigError } from '../errors.js';

export const PROVIDERS = [
  'openai',
  'anthropic',
  'gemini',
  'azure-openai',
  'azure-anthropic',
  'ollama',
  'litellm',
  'mlx',
] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export function parseProvider(raw: string, settingName: string): ProviderName {
  const v = raw.trim().toLowerCase() as ProviderName;
  if (!PROVIDERS.includes(v)) {
    throw new ConfigError(`${settingName}="${raw}" is not a supported provider. Supported: ${PROVIDERS.join(', ')}.`);
  }
  return v;
}

/** Absolute path of the wiki root (`LLM_WIKI_ROOT` or `--root`). */
export function wikiRoot(config: Config): string {
  const raw = config.require('LLM_WIKI_ROOT', 'It must point at a directory created with `llm-wiki init <dir>`.');
  return path.resolve(raw);
}

export interface ChatSettings {
  provider: ProviderName;
  model: string;
}

export function chatSettings(config: Config): ChatSettings {
  const provider = parseProvider(config.require('LLM_WIKI_PROVIDER'), 'LLM_WIKI_PROVIDER');
  const model =
    provider === 'azure-openai'
      ? config.require('AZURE_OPENAI_DEPLOYMENT', 'For Azure OpenAI the chat deployment name is the model.')
      : config.require('LLM_WIKI_MODEL');
  return { provider, model };
}

export interface EmbeddingSettings {
  provider: ProviderName;
  model: string;
}

export function embeddingSettings(config: Config): EmbeddingSettings {
  const provider = parseProvider(
    config.require('LLM_WIKI_EMBEDDING_PROVIDER', 'Needed for vector/hybrid search.'),
    'LLM_WIKI_EMBEDDING_PROVIDER',
  );
  if (provider === 'anthropic' || provider === 'azure-anthropic') {
    throw new ConfigError(`LLM_WIKI_EMBEDDING_PROVIDER=${provider} is not usable: Anthropic models do not produce embeddings.`);
  }
  const model = config.require('LLM_WIKI_EMBEDDING_MODEL', 'The embedding model (or Azure deployment) name.');
  return { provider, model };
}

export interface ParserSettings {
  provider: ProviderName;
  model: string;
}

/**
 * Dedicated LLM used to convert PDF / DOCX originals into markdown.
 * Kept separate from the chat model so a document-capable model can be chosen independently.
 */
export function parserSettings(config: Config): ParserSettings {
  const provider = parseProvider(
    config.require('LLM_WIKI_PARSER_PROVIDER', 'Needed to convert PDF/DOCX originals into markdown.'),
    'LLM_WIKI_PARSER_PROVIDER',
  );
  const model = config.require('LLM_WIKI_PARSER_MODEL', 'The document-parsing model (for Azure OpenAI: the deployment name).');
  return { provider, model };
}

/** True when the user has configured an embedding provider, so hybrid search is possible. */
export function embeddingsConfigured(config: Config): boolean {
  return config.has('LLM_WIKI_EMBEDDING_PROVIDER') && config.has('LLM_WIKI_EMBEDDING_MODEL');
}
