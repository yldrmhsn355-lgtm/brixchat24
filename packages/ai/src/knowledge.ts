import type { EmbeddingProvider, KnowledgeChunkRef } from "./types";

/**
 * Knowledge indexing + retrieval primitives.
 *
 * Storage is Postgres without pgvector, so retrieval is hybrid: the
 * repository produces lexical candidates via the GIN full-text index and the
 * ranker here re-orders them with cosine similarity over stored embeddings
 * (jsonb float arrays). When embeddings are unavailable the lexical score is
 * used alone — the system degrades, it does not break.
 */

export interface TextChunk {
  index: number;
  content: string;
  tokenCount: number;
}

/** Rough token estimate; good enough for chunk sizing decisions. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Paragraph-first chunker with sentence fallback. Targets ~350 tokens per
 * chunk with ~40 tokens of overlap so answers that straddle a boundary stay
 * retrievable.
 */
export function chunkText(
  text: string,
  options: { targetTokens?: number; overlapTokens?: number } = {},
): TextChunk[] {
  const targetTokens = options.targetTokens ?? 350;
  const overlapTokens = options.overlapTokens ?? 40;
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  const pieces: string[] = [];
  for (const paragraph of paragraphs) {
    if (estimateTokens(paragraph) <= targetTokens) {
      pieces.push(paragraph);
      continue;
    }
    // Oversized paragraph: split on sentence boundaries.
    const sentences = paragraph.split(/(?<=[.!?…])\s+/);
    let current = "";
    for (const sentence of sentences) {
      if (current && estimateTokens(current + " " + sentence) > targetTokens) {
        pieces.push(current.trim());
        current = sentence;
      } else {
        current = current ? current + " " + sentence : sentence;
      }
    }
    if (current.trim()) pieces.push(current.trim());
  }

  const chunks: TextChunk[] = [];
  let buffer = "";
  for (const piece of pieces) {
    if (buffer && estimateTokens(buffer + "\n\n" + piece) > targetTokens) {
      chunks.push({
        index: chunks.length,
        content: buffer.trim(),
        tokenCount: estimateTokens(buffer),
      });
      const overlap = buffer.slice(-overlapTokens * 4);
      buffer = overlap ? overlap + "\n\n" + piece : piece;
    } else {
      buffer = buffer ? buffer + "\n\n" + piece : piece;
    }
  }
  if (buffer.trim()) {
    chunks.push({
      index: chunks.length,
      content: buffer.trim(),
      tokenCount: estimateTokens(buffer),
    });
  }
  return chunks;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface RetrievalCandidate {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  knowledgeBaseId: string;
  content: string;
  lexicalScore: number;
  embedding: number[] | null;
}

/**
 * Hybrid ranking: normalized lexical score blended with cosine similarity
 * when a query embedding is available. Results under `minScore` are dropped
 * so irrelevant chunks never reach the prompt.
 */
export function rankCandidates(
  candidates: RetrievalCandidate[],
  queryEmbedding: number[] | null,
  options: { limit?: number; minScore?: number } = {},
): KnowledgeChunkRef[] {
  const limit = options.limit ?? 5;
  const minScore = options.minScore ?? 0.12;
  const maxLexical = Math.max(...candidates.map((c) => c.lexicalScore), 0.000001);

  const scored = candidates.map((candidate) => {
    const lexical = candidate.lexicalScore / maxLexical;
    let score = lexical;
    if (queryEmbedding && candidate.embedding && candidate.embedding.length > 0) {
      const semantic = Math.max(cosineSimilarity(queryEmbedding, candidate.embedding), 0);
      score = 0.35 * lexical + 0.65 * semantic;
    }
    return { candidate, score };
  });

  return scored
    .filter((entry) => entry.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => ({
      chunkId: entry.candidate.chunkId,
      documentId: entry.candidate.documentId,
      documentTitle: entry.candidate.documentTitle,
      knowledgeBaseId: entry.candidate.knowledgeBaseId,
      score: Number(entry.score.toFixed(4)),
      content: entry.candidate.content,
    }));
}

/**
 * OpenRouter embeddings endpoint provider. Model ids are configurable —
 * nothing in the platform assumes a specific embedding model, and stored
 * chunks record which model produced their vectors so mixed-model corpora
 * are never compared against each other.
 */
export class OpenRouterEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private readonly apiKey: string,
    public readonly model: string,
    private readonly baseUrl = "https://openrouter.ai/api/v1",
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `embedding_request_failed:${response.status}:${body.slice(0, 200)}`,
      );
    }
    const payload = (await response.json()) as {
      data?: Array<{ index: number; embedding: number[] }>;
    };
    const rows = payload.data ?? [];
    const result: number[][] = new Array(texts.length).fill(null).map(() => []);
    for (const row of rows) {
      if (row.index >= 0 && row.index < texts.length) {
        result[row.index] = row.embedding;
      }
    }
    return result;
  }
}

/**
 * Deterministic local fallback used in tests and when no embedding model is
 * configured: hashed bag-of-words projected into a fixed-size vector. Weak
 * semantics, but stable, free, and keeps the hybrid ranker exercised.
 */
export class HashEmbeddingProvider implements EmbeddingProvider {
  public readonly model = "local/hash-256";

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const vector = new Array<number>(256).fill(0);
      const words = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      for (const word of words) {
        let hash = 2166136261;
        for (let i = 0; i < word.length; i += 1) {
          hash ^= word.charCodeAt(i);
          hash = Math.imul(hash, 16777619);
        }
        const slot = Math.abs(hash) % 256;
        vector[slot] = (vector[slot] ?? 0) + 1;
      }
      return vector;
    });
  }
}

/** Build a compact retrieval query from the latest customer messages. */
export function buildRetrievalQuery(messages: string[]): string {
  return messages.join(" ").replace(/\s+/g, " ").trim().slice(0, 500);
}
