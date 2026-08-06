import { normalizeSnippet } from "./normalize.js";

export interface ChunkInput {
  text: string;
  doc_type: string;
  source: string;
  region?: string;
  date?: string;
  page?: number;
  section?: string;
  object_key?: string;
}

export interface Chunk {
  text: string;
  chunk_index: number;
  doc_type: string;
  source: string;
  region: string | null;
  date: string | null;
  page: number | null;
  section: string | null;
  object_key: string | null;
}

const TARGET_TOKENS = 500;
const OVERLAP_TOKENS = 50;
const WORDS_PER_TOKEN_ESTIMATE = 0.75;

function estimateTokenCount(words: string[]): number {
  return Math.ceil(words.length * WORDS_PER_TOKEN_ESTIMATE);
}

/**
 * Deterministically split a document into overlapping chunks.
 * Token counts are estimated from word counts. Same input always produces the same output.
 */
export function chunkDocument(input: ChunkInput): Chunk[] {
  const normalized = normalizeSnippet(input.text);
  if (!normalized) {
    return [];
  }

  const words = normalized.split(" ");
  const targetWords = Math.ceil(TARGET_TOKENS / WORDS_PER_TOKEN_ESTIMATE);
  const overlapWords = Math.ceil(OVERLAP_TOKENS / WORDS_PER_TOKEN_ESTIMATE);

  const chunks: Chunk[] = [];
  let i = 0;
  let chunkIndex = 0;

  while (i < words.length) {
    const end = Math.min(i + targetWords, words.length);
    const chunkWords = words.slice(i, end);

    chunks.push({
      text: chunkWords.join(" "),
      chunk_index: chunkIndex,
      doc_type: input.doc_type,
      source: input.source,
      region: input.region ?? null,
      date: input.date ?? null,
      page: input.page ?? null,
      section: input.section ?? null,
      object_key: input.object_key ?? null,
    });

    if (end === words.length) {
      break;
    }

    i += targetWords - overlapWords;
    chunkIndex += 1;
  }

  return chunks;
}
