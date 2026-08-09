import { normalizeSnippet } from "./normalize.js";
import type { ProposalDocument, CodeClaim } from "./agents/writer.js";
import type { Retrieved } from "./retrieval.js";

export interface GatedProposal {
  proposal: ProposalDocument;
  moved: MovedClaim[];
}

export interface MovedClaim {
  claim: string;
  reason: string;
}

/**
 * Verify each code claim against the retrieved chunk set. If a claim cites a
 * chunk that was not retrieved or if the snippet is not found in the chunk
 * text, move the claim into the assumptions list with a reason and remove it
 * from code_claims.
 */
export function runCodeClaimGate(
  proposal: ProposalDocument,
  retrieved: Map<string, Retrieved>
): GatedProposal {
  const kept: CodeClaim[] = [];
  const moved: MovedClaim[] = [];

  for (const claim of proposal.code_claims) {
    const chunk = retrieved.get(claim.chunk_id);
    if (!chunk) {
      moved.push({ claim: claim.claim, reason: `chunk ${claim.chunk_id} was not retrieved` });
      continue;
    }
    const normalizedSnippet = normalizeSnippet(claim.snippet);
    const normalizedChunk = normalizeSnippet(chunk.text);
    if (!normalizedSnippet) {
      moved.push({ claim: claim.claim, reason: "snippet is empty after normalization" });
      continue;
    }
    if (!normalizedChunk.includes(normalizedSnippet)) {
      moved.push({ claim: claim.claim, reason: "snippet not found in retrieved chunk text" });
      continue;
    }
    kept.push(claim);
  }

  const assumptions = proposal.assumptions.slice();
  for (const item of moved) {
    assumptions.push(`${item.claim} (moved to assumptions: ${item.reason})`);
  }

  return {
    proposal: {
      ...proposal,
      assumptions,
      code_claims: kept,
    },
    moved,
  };
}
