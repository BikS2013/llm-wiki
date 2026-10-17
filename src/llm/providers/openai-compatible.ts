import OpenAI, { AzureOpenAI } from 'openai';
import { IMAGE_MIMES, type ChatClient, type ChatRequest, type DocumentParser, type EmbeddingClient, type ParseRequest } from '../types.js';
import { LlmError } from '../../errors.js';

export interface OpenAiCompatibleOptions {
  provider: string;
  model: string;
  client: OpenAI;
  /**
   * Whether the endpoint accepts `file` content parts (OpenAI, Azure OpenAI, LiteLLM); local servers get
   * extracted text. Images are always sent as `image_url` parts — the model must support vision.
   */
  nativePdf: boolean;
}

/** Chat + embeddings over the OpenAI wire format: OpenAI, Azure OpenAI, Ollama, LiteLLM, MLX. */
export class OpenAiCompatibleClient implements ChatClient, EmbeddingClient, DocumentParser {
  readonly provider: string;
  readonly model: string;
  private readonly client: OpenAI;
  private readonly nativePdf: boolean;

  constructor(opts: OpenAiCompatibleOptions) {
    this.provider = opts.provider;
    this.model = opts.model;
    this.client = opts.client;
    this.nativePdf = opts.nativePdf;
  }

  nativeMimeTypes(): ReadonlySet<string> {
    return new Set([...(this.nativePdf ? ['application/pdf'] : []), ...IMAGE_MIMES]);
  }

  async chat(req: ChatRequest): Promise<string> {
    return this.complete(req.system, [{ type: 'text', text: req.user }], req.maxTokens, req.json === true);
  }

  async parseDocument(req: ParseRequest): Promise<string> {
    const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
    const dataUrl = (mime: string, bytes: Buffer) => `data:${mime};base64,${bytes.toString('base64')}`;
    if (IMAGE_MIMES.has(req.document.mimeType)) {
      parts.push({ type: 'image_url', image_url: { url: dataUrl(req.document.mimeType, req.document.bytes) } });
    } else if (this.nativeMimeTypes().has(req.document.mimeType)) {
      parts.push({ type: 'file', file: { filename: req.document.filename, file_data: `data:${req.document.mimeType};base64,${req.document.bytes.toString('base64')}` } });
    } else {
      if (req.extractedText === undefined) throw new LlmError(`${this.provider} cannot read ${req.document.mimeType} natively and no extracted text was supplied.`);
      parts.push({ type: 'text', text: `<document filename="${req.document.filename}">\n${req.extractedText}\n</document>` });
    }
    for (const img of req.images ?? []) {
      parts.push({ type: 'text', text: `Image: ${img.label}` });
      parts.push({ type: 'image_url', image_url: { url: dataUrl(img.mimeType, img.bytes) } });
    }
    parts.push({ type: 'text', text: req.instruction });
    return this.complete(req.system, parts, req.maxTokens);
  }

  private async complete(system: string, parts: OpenAI.Chat.Completions.ChatCompletionContentPart[], maxTokens: number, json = false): Promise<string> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      max_completion_tokens: maxTokens,
      stream: true,
      ...(json ? { response_format: { type: 'json_object' as const } } : {}),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: parts },
      ],
    });
    let text = '';
    let finish: string | null | undefined;
    for await (const part of stream) {
      const choice = part.choices[0];
      text += choice?.delta?.content ?? '';
      if (choice?.finish_reason) finish = choice.finish_reason;
    }
    if (finish === 'length') throw new LlmError(`${this.provider}/${this.model} hit the ${maxTokens}-token output limit before finishing; increase --max-tokens.`);
    if (text.trim() === '') throw new LlmError(`${this.provider}/${this.model} returned an empty reply.`);
    return text;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const res = await this.client.embeddings.create({ model: this.model, input: texts });
    return res.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}

export function makeOpenAi(opts: { apiKey: string; baseURL?: string; organization?: string }): OpenAI {
  const init: ConstructorParameters<typeof OpenAI>[0] = { apiKey: opts.apiKey };
  if (opts.baseURL) init.baseURL = opts.baseURL;
  if (opts.organization) init.organization = opts.organization;
  return new OpenAI(init);
}

export function makeAzureOpenAi(opts: { apiKey: string; endpoint: string; apiVersion: string; deployment: string }): OpenAI {
  return new AzureOpenAI({ apiKey: opts.apiKey, endpoint: opts.endpoint, apiVersion: opts.apiVersion, deployment: opts.deployment });
}
