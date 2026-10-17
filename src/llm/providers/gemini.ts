import { GoogleGenAI, type Part } from '@google/genai';
import { IMAGE_MIMES, type ChatClient, type ChatRequest, type DocumentParser, type EmbeddingClient, type ParseRequest } from '../types.js';
import { LlmError } from '../../errors.js';

/** Gemini via the Google GenAI SDK (chat + embeddings). */
export class GeminiClient implements ChatClient, EmbeddingClient, DocumentParser {
  readonly provider = 'gemini';
  readonly model: string;
  private readonly ai: GoogleGenAI;

  constructor(model: string, apiKey: string) {
    this.model = model;
    this.ai = new GoogleGenAI({ apiKey });
  }

  nativeMimeTypes(): ReadonlySet<string> {
    return new Set(['application/pdf', ...IMAGE_MIMES]);
  }

  async chat(req: ChatRequest): Promise<string> {
    return this.complete(req.system, [{ text: req.user }], req.maxTokens, req.json === true);
  }

  async parseDocument(req: ParseRequest): Promise<string> {
    const parts: Part[] = [];
    if (req.document.mimeType === 'application/pdf' || IMAGE_MIMES.has(req.document.mimeType)) {
      parts.push({ inlineData: { mimeType: req.document.mimeType, data: req.document.bytes.toString('base64') } });
    } else {
      if (req.extractedText === undefined) throw new LlmError(`gemini cannot read ${req.document.mimeType} natively and no extracted text was supplied.`);
      parts.push({ text: `<document filename="${req.document.filename}">\n${req.extractedText}\n</document>` });
    }
    for (const img of req.images ?? []) {
      parts.push({ text: `Image: ${img.label}` });
      parts.push({ inlineData: { mimeType: img.mimeType, data: img.bytes.toString('base64') } });
    }
    parts.push({ text: req.instruction });
    return this.complete(req.system, parts, req.maxTokens);
  }

  private async complete(system: string, parts: Part[], maxTokens: number, json = false): Promise<string> {
    const res = await this.ai.models.generateContent({
      model: this.model,
      contents: [{ role: 'user', parts }],
      config: { systemInstruction: system, maxOutputTokens: maxTokens, ...(json ? { responseMimeType: 'application/json' } : {}) },
    });
    const text = res.text ?? '';
    if (text.trim() === '') throw new LlmError(`gemini/${this.model} returned an empty reply.`);
    return text;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const res = await this.ai.models.embedContent({ model: this.model, contents: texts });
    const vectors = (res.embeddings ?? []).map((e) => e.values ?? []);
    if (vectors.length !== texts.length) throw new LlmError(`gemini/${this.model} returned ${vectors.length} embeddings for ${texts.length} inputs.`);
    return vectors;
  }
}
