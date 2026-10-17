export interface ChatRequest {
  system: string;
  user: string;
  /** Upper bound for the reply; providers stream when needed. */
  maxTokens: number;
  /** The reply must be one JSON object: providers with a JSON mode (Gemini, OpenAI-compatible) enforce it. */
  json?: boolean | undefined;
}

export interface ChatClient {
  readonly provider: string;
  readonly model: string;
  chat(req: ChatRequest): Promise<string>;
}

export interface EmbeddingClient {
  readonly provider: string;
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export type DocumentMime =
  | 'application/pdf'
  | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  | 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  | ImageMime;

export const IMAGE_MIMES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export interface ImageInput {
  /** Label shown to the model before the image, e.g. `image3.png (slides 2, 5)`. */
  label: string;
  mimeType: ImageMime;
  bytes: Buffer;
}

export interface DocumentInput {
  filename: string;
  mimeType: DocumentMime;
  bytes: Buffer;
}

export interface ParseRequest {
  system: string;
  instruction: string;
  /** The original document; sent natively when the provider supports the mime type. */
  document: DocumentInput;
  /** Text/HTML extracted locally; used when the provider cannot read the document natively. */
  extractedText?: string | undefined;
  /** Pictures that belong to the document (e.g. slide images), sent after it as image inputs. */
  images?: ImageInput[] | undefined;
  maxTokens: number;
}

export interface DocumentParser {
  readonly provider: string;
  readonly model: string;
  /** Mime types this provider can ingest as a native attachment (PDF where supported, and images). */
  nativeMimeTypes(): ReadonlySet<string>;
  parseDocument(req: ParseRequest): Promise<string>;
}
