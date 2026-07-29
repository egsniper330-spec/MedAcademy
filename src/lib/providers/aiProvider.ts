/**
 * aiProvider.ts
 * AI Provider Interface
 * Current: Internal stub
 * Future: OpenAI, Claude, Gemini, Azure OpenAI, Local LLM
 */

export interface CompletionOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  stream?: boolean;
}

export interface CompletionResult {
  text: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  finishReason?: 'stop' | 'length' | 'error';
}

export interface EmbeddingResult {
  vector: number[];
  model: string;
  inputTokens?: number;
}

export interface AiProvider {
  readonly providerKey: string;
  readonly displayName: string;

  /** Generate a text completion / chat response */
  complete(prompt: string, options?: CompletionOptions): Promise<CompletionResult>;

  /** Generate embeddings for text */
  embed(text: string, model?: string): Promise<EmbeddingResult>;

  /** Classify text into categories */
  classify(text: string, categories: string[]): Promise<Record<string, number>>;

  /** Summarize a long text */
  summarize(text: string, maxLength?: number): Promise<string>;

  /** Translate text to a target language */
  translate(text: string, targetLanguage: string): Promise<string>;

  /** Check provider health */
  checkHealth(): Promise<'healthy' | 'warning' | 'offline' | 'maintenance' | 'unknown'>;
}
