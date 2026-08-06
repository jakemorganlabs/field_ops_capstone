import { normalizeSnippet } from "./normalize.js";

export interface Citation {
  chunk_id: string;
  snippet: string;
}

export interface BomLine {
  item: string;
  quantity: string;
  unit_cost: string;
  citation?: Citation;
  assumption?: boolean;
}

export interface LaborLine {
  role: string;
  hours: string;
  rate_key: string;
  citation?: Citation;
  assumption?: boolean;
}

export interface LineVerdict {
  index: number;
  verified: boolean;
  recast_assumption: boolean;
  reason: string | null;
}

function verifyCitation(
  citation: Citation | undefined,
  retrievedChunkIds: Set<string>,
  chunkTextById: Map<string, string>
): { verified: boolean; recast_assumption: boolean; reason: string | null } {
  if (!citation) {
    return {
      verified: false,
      recast_assumption: true,
      reason: "Line has no citation and is not marked as an assumption",
    };
  }

  if (!retrievedChunkIds.has(citation.chunk_id)) {
    return {
      verified: false,
      recast_assumption: true,
      reason: `Cited chunk ${citation.chunk_id} was not retrieved`,
    };
  }

  const chunkText = chunkTextById.get(citation.chunk_id);
  if (chunkText === undefined) {
    return {
      verified: false,
      recast_assumption: true,
      reason: `Cited chunk ${citation.chunk_id} has no text`,
    };
  }

  const normalizedSnippet = normalizeSnippet(citation.snippet);
  const normalizedChunk = normalizeSnippet(chunkText);
  if (!normalizedSnippet) {
    return {
      verified: false,
      recast_assumption: true,
      reason: "Citation snippet is empty after normalization",
    };
  }

  if (normalizedChunk.includes(normalizedSnippet)) {
    return { verified: true, recast_assumption: false, reason: null };
  }

  return {
    verified: false,
    recast_assumption: true,
    reason: "Citation snippet not found in retrieved chunk text",
  };
}

/**
 * Verify that every BOM line and labor line cites a retrieved chunk and that the
 * snippet text is present in the chunk. Lines marked as assumptions bypass the check.
 * A failed line is recast as an assumption.
 */
export function verifyBomCitations(
  lines: BomLine[],
  retrievedChunkIds: Set<string>,
  chunkTextById: Map<string, string>
): LineVerdict[] {
  return lines.map((line, index) => {
    if (line.assumption === true) {
      return { index, verified: true, recast_assumption: false, reason: null };
    }
    const result = verifyCitation(line.citation, retrievedChunkIds, chunkTextById);
    return { index, ...result };
  });
}

export interface LaborVerdict {
  index: number;
  verified: boolean;
  recast_assumption: boolean;
  reason: string | null;
}

export function verifyLaborCitations(
  labor: LaborLine[],
  retrievedChunkIds: Set<string>,
  chunkTextById: Map<string, string>
): LaborVerdict[] {
  return labor.map((line, index) => {
    if (line.assumption === true) {
      return { index, verified: true, recast_assumption: false, reason: null };
    }
    const result = verifyCitation(line.citation, retrievedChunkIds, chunkTextById);
    return { index, ...result };
  });
}
