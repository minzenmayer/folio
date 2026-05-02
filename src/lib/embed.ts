// Folio · Embedding pipeline
// Uses OpenAI text-embedding-3-small (1536 dims).
// Sprint 1–2: stub. Wired in Sprint 3–4 when captures land.

import { openai } from '@ai-sdk/openai';
import { embed } from 'ai';

if (!process.env.OPENAI_API_KEY) {
  console.warn(
    '[folio/embed] OPENAI_API_KEY is not set. Embeddings will fail until added.'
  );
}

export async function embedText(text: string): Promise<number[]> {
  const cleaned = text.trim().replace(/\s+/g, ' ');
  if (cleaned.length === 0) {
    throw new Error('embedText: empty input');
  }

  const { embedding } = await embed({
    model: openai.embedding('text-embedding-3-small'),
    value: cleaned,
  });

  return embedding;
}

// Convenience: embed multiple captures in parallel.
// Used by Sprint 3–4 ingestion pipeline.
export async function embedBatch(texts: string[]): Promise<number[][]> {
  return Promise.all(texts.map(embedText));
}
