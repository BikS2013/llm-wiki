import type { Config } from '../config/env.js';
import { chatSettings, embeddingSettings, parserSettings, type ProviderName } from '../config/settings.js';
import { ConfigError } from '../errors.js';
import { AnthropicClient, makeAnthropic, makeFoundry } from './providers/anthropic.js';
import { GeminiClient } from './providers/gemini.js';
import { OpenAiCompatibleClient, makeAzureOpenAi, makeOpenAi } from './providers/openai-compatible.js';
import type { ChatClient, DocumentParser, EmbeddingClient } from './types.js';

/** Local OpenAI-compatible servers (Ollama, MLX) ignore the key but the SDK insists on a non-empty string. */
const LOCAL_PLACEHOLDER_KEY = 'local';

function openAiCompatible(config: Config, provider: ProviderName, model: string): OpenAiCompatibleClient {
  // Hosted OpenAI-format endpoints accept `file` parts; local servers (Ollama, MLX) get extracted text instead.
  const nativePdf = provider === 'openai' || provider === 'azure-openai' || provider === 'litellm';
  switch (provider) {
    case 'openai': {
      const opts: Parameters<typeof makeOpenAi>[0] = { apiKey: config.require('OPENAI_API_KEY') };
      const baseURL = config.get('OPENAI_BASE_URL');
      const organization = config.get('OPENAI_ORG_ID');
      if (baseURL) opts.baseURL = baseURL;
      if (organization) opts.organization = organization;
      return new OpenAiCompatibleClient({ provider, model, nativePdf, client: makeOpenAi(opts) });
    }
    case 'azure-openai':
      return new OpenAiCompatibleClient({
        provider,
        model,
        nativePdf,
        client: makeAzureOpenAi({
          apiKey: config.require('AZURE_OPENAI_API_KEY'),
          endpoint: config.require('AZURE_OPENAI_ENDPOINT'),
          apiVersion: config.require('AZURE_OPENAI_API_VERSION'),
          deployment: model,
        }),
      });
    case 'ollama': {
      const host = config.require('OLLAMA_HOST', 'For example http://localhost:11434.').replace(/\/+$/, '');
      return new OpenAiCompatibleClient({ provider, model, nativePdf, client: makeOpenAi({ apiKey: LOCAL_PLACEHOLDER_KEY, baseURL: `${host}/v1` }) });
    }
    case 'litellm':
      return new OpenAiCompatibleClient({
        provider,
        model,
        nativePdf,
        client: makeOpenAi({ apiKey: config.require('LITELLM_MASTER_KEY'), baseURL: config.require('LITELLM_PROXY_URL') }),
      });
    case 'mlx':
      return new OpenAiCompatibleClient({
        provider,
        model,
        nativePdf,
        client: makeOpenAi({ apiKey: LOCAL_PLACEHOLDER_KEY, baseURL: config.require('OPENAI_BASE_URL', 'MLX-LM serves an OpenAI-compatible API; point OPENAI_BASE_URL at it.') }),
      });
    default:
      throw new ConfigError(`Provider ${provider} is not OpenAI-compatible.`);
  }
}

function buildClient(config: Config, provider: ProviderName, model: string): ChatClient & DocumentParser {
  switch (provider) {
    case 'anthropic': {
      const opts: Parameters<typeof makeAnthropic>[0] = { apiKey: config.require('ANTHROPIC_API_KEY') };
      const baseURL = config.get('ANTHROPIC_BASE_URL');
      if (baseURL) opts.baseURL = baseURL;
      return new AnthropicClient(provider, model, makeAnthropic(opts));
    }
    case 'azure-anthropic':
      return new AnthropicClient(
        provider,
        model,
        makeFoundry({ apiKey: config.require('AZURE_AI_INFERENCE_KEY'), endpoint: config.require('AZURE_AI_INFERENCE_ENDPOINT') }),
      );
    case 'gemini':
      return new GeminiClient(model, config.requireAny(['GOOGLE_API_KEY', 'GEMINI_API_KEY']));
    default:
      return openAiCompatible(config, provider, model);
  }
}

/** Builds the chat client from `LLM_WIKI_PROVIDER` / `LLM_WIKI_MODEL` and the vendor-canonical variables. */
export function createChatClient(config: Config): ChatClient {
  const { provider, model } = chatSettings(config);
  return buildClient(config, provider, model);
}

/** Builds the document parser from `LLM_WIKI_PARSER_PROVIDER` / `LLM_WIKI_PARSER_MODEL`. */
export function createParserClient(config: Config): DocumentParser {
  const { provider, model } = parserSettings(config);
  return buildClient(config, provider, model);
}

/** Builds the embedding client from `LLM_WIKI_EMBEDDING_PROVIDER` / `LLM_WIKI_EMBEDDING_MODEL`. */
export function createEmbeddingClient(config: Config): EmbeddingClient {
  const { provider, model } = embeddingSettings(config);
  if (provider === 'gemini') return new GeminiClient(model, config.requireAny(['GOOGLE_API_KEY', 'GEMINI_API_KEY']));
  return openAiCompatible(config, provider, model);
}
