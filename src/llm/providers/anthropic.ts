import Anthropic from '@anthropic-ai/sdk';
import { AnthropicFoundry } from '@anthropic-ai/foundry-sdk';
import type { ChatClient, ChatRequest, DocumentParser, ParseRequest } from '../types.js';
import { LlmError } from '../../errors.js';

type MessagesApi = { messages: Pick<Anthropic['messages'], 'stream'> };

/** Claude via the direct Anthropic API or via Microsoft Foundry (Azure). */
export class AnthropicClient implements ChatClient, DocumentParser {
  readonly provider: string;
  readonly model: string;
  private readonly client: MessagesApi;

  constructor(provider: string, model: string, client: MessagesApi) {
    this.provider = provider;
    this.model = model;
    this.client = client;
  }

  nativeMimeTypes(): ReadonlySet<string> {
    return new Set(['application/pdf']);
  }

  async chat(req: ChatRequest): Promise<string> {
    return this.complete(req.system, [{ type: 'text', text: req.user }], req.maxTokens);
  }

  async parseDocument(req: ParseRequest): Promise<string> {
    const blocks: Anthropic.ContentBlockParam[] = [];
    if (req.document.mimeType === 'application/pdf') {
      blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: req.document.bytes.toString('base64') }, title: req.document.filename });
    } else {
      if (req.extractedText === undefined) throw new LlmError(`${this.provider} cannot read ${req.document.mimeType} natively and no extracted text was supplied.`);
      blocks.push({ type: 'document', source: { type: 'text', media_type: 'text/plain', data: req.extractedText }, title: req.document.filename });
    }
    blocks.push({ type: 'text', text: req.instruction });
    return this.complete(req.system, blocks, req.maxTokens);
  }

  private async complete(system: string, content: Anthropic.ContentBlockParam[], maxTokens: number): Promise<string> {
    const message = await this.client.messages
      .stream({
        model: this.model,
        max_tokens: maxTokens,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content }],
      })
      .finalMessage();
    if (message.stop_reason === 'refusal') {
      const details = message.stop_details ? ` (${message.stop_details.category ?? 'unspecified'}: ${message.stop_details.explanation ?? ''})` : '';
      throw new LlmError(`${this.provider}/${this.model} refused the request${details}.`);
    }
    if (message.stop_reason === 'max_tokens') throw new LlmError(`${this.provider}/${this.model} hit the ${maxTokens}-token output limit before finishing; increase --max-tokens.`);
    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    if (text.trim() === '') throw new LlmError(`${this.provider}/${this.model} returned an empty reply.`);
    return text;
  }
}

export function makeAnthropic(opts: { apiKey: string; baseURL?: string }): Anthropic {
  const init: ConstructorParameters<typeof Anthropic>[0] = { apiKey: opts.apiKey };
  if (opts.baseURL) init.baseURL = opts.baseURL;
  return new Anthropic(init);
}

export function makeFoundry(opts: { apiKey: string; endpoint: string }): AnthropicFoundry {
  return new AnthropicFoundry({ apiKey: opts.apiKey, baseURL: opts.endpoint });
}
