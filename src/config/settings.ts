import fs from 'node:fs';
import path from 'node:path';
import { tierRank, type Config } from './env.js';
import { ConfigError } from '../errors.js';
import type { WikiRegistry } from '../wiki/registry.js';

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

export interface ResolvedWiki {
  root: string;
  /** Registry name, when the wiki is registered. */
  name?: string;
  /** What selected it: an explicit path, an explicit name, or the registry's current selection. */
  via: 'LLM_WIKI_ROOT' | 'LLM_WIKI_NAME' | 'current';
}

/**
 * Decides which wiki a command operates on, without ever guessing:
 * 1. `LLM_WIKI_ROOT` (`--root`) or `LLM_WIKI_NAME` (`--wiki`), whichever comes from the higher
 *    configuration tier; both in the same tier is an error.
 * 2. Otherwise the registry's current selection (`llm-wiki wikis use <name>`).
 * Returns undefined when nothing selects a wiki.
 */
export function resolveWiki(config: Config, registry: WikiRegistry): ResolvedWiki | undefined {
  const rootTier = config.source('LLM_WIKI_ROOT');
  const nameTier = config.source('LLM_WIKI_NAME');
  if (rootTier !== undefined && nameTier !== undefined && rootTier === nameTier) {
    throw new ConfigError(`Both LLM_WIKI_ROOT and LLM_WIKI_NAME are set at the ${rootTier} tier; set only one (or pass --root / --wiki to choose).`);
  }
  const useName = nameTier !== undefined && (rootTier === undefined || tierRank(nameTier) > tierRank(rootTier));
  if (useName) {
    const e = registry.get(config.require('LLM_WIKI_NAME'));
    return { root: e.root, name: e.name, via: 'LLM_WIKI_NAME' };
  }
  if (rootTier !== undefined) {
    const root = path.resolve(config.require('LLM_WIKI_ROOT'));
    const name = registry.nameForRoot(root);
    return { root, ...(name ? { name } : {}), via: 'LLM_WIKI_ROOT' };
  }
  const current = registry.current;
  if (current !== undefined) {
    const e = registry.get(current);
    return { root: e.root, name: e.name, via: 'current' };
  }
  return undefined;
}

/** Like resolveWiki but throws a ConfigError that lists the registered wikis. */
export function requireWiki(config: Config, registry: WikiRegistry): ResolvedWiki {
  const r = resolveWiki(config, registry);
  if (r) return r;
  const names = registry.list().map((w) => w.name);
  throw new ConfigError(
    'No wiki selected. ' +
      (names.length
        ? `Pass --wiki <name> (registered: ${names.join(', ')}), select one with \`llm-wiki wikis use <name>\`, or set LLM_WIKI_NAME / LLM_WIKI_ROOT.`
        : 'No wikis are registered yet: create one with `llm-wiki init <dir> --name <name>`, or set LLM_WIKI_ROOT / pass --root.'),
  );
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
    config.require('LLM_WIKI_PARSER_PROVIDER', 'Needed to convert PDF, DOCX, PPTX and image originals into markdown (a model with vision for images).'),
    'LLM_WIKI_PARSER_PROVIDER',
  );
  const model = config.require('LLM_WIKI_PARSER_MODEL', 'The document-parsing model (for Azure OpenAI: the deployment name).');
  return { provider, model };
}

/** True when the user has configured an embedding provider, so hybrid search is possible. */
export function embeddingsConfigured(config: Config): boolean {
  return config.has('LLM_WIKI_EMBEDDING_PROVIDER') && config.has('LLM_WIKI_EMBEDDING_MODEL');
}

/**
 * Absolute path of the Chromium-family browser (Chrome, Chromium, Edge, Brave) used to render pages that
 * build their content with JavaScript. Optional: undefined when not set; the operation that needs it then
 * raises a ConfigError naming LLM_WIKI_BROWSER.
 */
export function browserPath(config: Config): string | undefined {
  const value = config.get('LLM_WIKI_BROWSER');
  if (value === undefined) return undefined;
  if (!fs.existsSync(value)) throw new ConfigError(`LLM_WIKI_BROWSER=${value} does not exist; point it at a Chromium-family browser executable.`);
  return value;
}
