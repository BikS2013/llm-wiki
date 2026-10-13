export interface ChatRequest {
  system: string;
  user: string;
  /** Upper bound for the reply; providers stream when needed. */
  maxTokens: number;
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

export type DocumentMime = 'application/pdf' | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

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
  maxTokens: number;
}

export interface DocumentParser {
  readonly provider: string;
  readonly model: string;
  /** Mime types this provider can ingest as a native document attachment. */
  nativeMimeTypes(): ReadonlySet<string>;
  parseDocument(req: ParseRequest): Promise<string>;
}
