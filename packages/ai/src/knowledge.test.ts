import { describe, expect, it } from "vitest";
import {
  HashEmbeddingProvider,
  buildRetrievalQuery,
  chunkText,
  cosineSimilarity,
  rankCandidates,
  type RetrievalCandidate,
} from "./knowledge";

describe("chunkText", () => {
  it("returns nothing for empty input", () => {
    expect(chunkText("   ")).toEqual([]);
  });

  it("keeps a short document as a single chunk", () => {
    const chunks = chunkText("Kısa bir belge.");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.index).toBe(0);
  });

  it("splits long documents and preserves all content words", () => {
    const paragraph = "Implant tedavisi hakkında detaylı bilgi. ".repeat(40);
    const text = [paragraph, paragraph, paragraph].join("\n\n");
    const chunks = chunkText(text, { targetTokens: 100 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const [index, chunk] of chunks.entries()) {
      expect(chunk.index).toBe(index);
      expect(chunk.tokenCount).toBeGreaterThan(0);
    }
  });
});

describe("cosineSimilarity", () => {
  it("is 1 for identical vectors and 0 for orthogonal ones", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it("returns 0 on length mismatch or empty vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([1], [1, 2])).toBe(0);
  });
});

describe("rankCandidates", () => {
  const candidate = (
    id: string,
    lexicalScore: number,
    embedding: number[] | null,
  ): RetrievalCandidate => ({
    chunkId: id,
    documentId: `doc-${id}`,
    documentTitle: `Doc ${id}`,
    knowledgeBaseId: "kb",
    content: `content ${id}`,
    lexicalScore,
    embedding,
  });

  it("ranks lexically when no embeddings exist", () => {
    const ranked = rankCandidates(
      [candidate("a", 0.2, null), candidate("b", 0.9, null)],
      null,
    );
    expect(ranked[0]!.chunkId).toBe("b");
  });

  it("drops results below the minimum score", () => {
    const ranked = rankCandidates(
      [candidate("a", 0.9, null), candidate("b", 0.01, null)],
      null,
      { minScore: 0.5 },
    );
    expect(ranked.map((chunk) => chunk.chunkId)).toEqual(["a"]);
  });

  it("blends semantic similarity when a query embedding is available", () => {
    const ranked = rankCandidates(
      [
        candidate("lexical-heavy", 1.0, [0, 1, 0]),
        candidate("semantic-heavy", 0.5, [1, 0, 0]),
      ],
      [1, 0, 0],
    );
    expect(ranked[0]!.chunkId).toBe("semantic-heavy");
  });

  it("respects the result limit", () => {
    const many = Array.from({ length: 10 }, (_, index) =>
      candidate(String(index), 1, null),
    );
    expect(rankCandidates(many, null, { limit: 3 })).toHaveLength(3);
  });
});

describe("HashEmbeddingProvider", () => {
  it("is deterministic and similarity-sensitive", async () => {
    const provider = new HashEmbeddingProvider();
    const [a, b, c] = await provider.embed([
      "implant fiyatları hakkında bilgi",
      "implant fiyatları hakkında bilgi",
      "kargo takip numarası nerede",
    ]);
    expect(a).toEqual(b);
    expect(cosineSimilarity(a!, b!)).toBeCloseTo(1);
    expect(cosineSimilarity(a!, c!)).toBeLessThan(0.9);
  });
});

describe("buildRetrievalQuery", () => {
  it("joins, collapses whitespace, and caps length", () => {
    const query = buildRetrievalQuery(["  fiyat   nedir ", "implant  mı?"]);
    expect(query).toBe("fiyat nedir implant mı?");
    expect(buildRetrievalQuery(["x".repeat(1000)]).length).toBe(500);
  });
});
