import { createHash } from "node:crypto";

function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    return value.trim().toLowerCase();
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      const canonicalValue = canonicalize(obj[key]);
      if (canonicalValue !== null) {
        sorted[key] = canonicalValue;
      }
    }
    return sorted;
  }

  return String(value);
}

/**
 * Produce a deterministic SHA-256 idempotency key for an intake payload.
 * Strings are trimmed and lowercased, object keys are sorted, and null optional
 * fields are dropped before hashing.
 */
export function intakeIdempotencyKey(intake: unknown): string {
  const canonical = canonicalize(intake);
  const json = JSON.stringify(canonical);
  return createHash("sha256").update(json).digest("hex");
}
