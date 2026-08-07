import { createHmac, timingSafeEqual } from "node:crypto";

const WINDOW_SECONDS = 300;

export interface SignedHeader {
  ts: number;
  sig: string;
  header: string;
}

/**
 * Sign an HTTP request.
 *
 * body_hash = HMAC-SHA256(secret, body) as hex
 * data = "ts.METHOD.path.body_hash"
 * sig = HMAC-SHA256(secret, data) as hex
 * Header: "Authorization: HMAC ts:sig"
 *
 * CLI recipe (bash):
 *   body_hash=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$secret" -binary | xxd -p -c 64)
 *   data="${ts}.POST./intake.${body_hash}"
 *   sig=$(printf '%s' "$data" | openssl dgst -sha256 -hmac "$secret" -binary | xxd -p -c 64)
 *   curl -H "Authorization: HMAC ${ts}:${sig}" -d @body.json http://127.0.0.1:3004/intake
 */
export function signRequest(opts: {
  secret: string;
  method: string;
  path: string;
  body: string;
  ts?: number;
}): SignedHeader {
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  const bodyHash = createHmac("sha256", opts.secret).update(opts.body).digest("hex");
  const data = `${ts}.${opts.method}.${opts.path}.${bodyHash}`;
  const sig = createHmac("sha256", opts.secret).update(data).digest("hex");
  return { ts, sig, header: `HMAC ${ts}:${sig}` };
}

export function verifyRequest(opts: {
  secret: string;
  method: string;
  path: string;
  body: string;
  authorization: string;
  now?: number;
}): { ok: boolean; error?: string } {
  const now = opts.now ?? Math.floor(Date.now() / 1000);

  const parts = opts.authorization.split(" ");
  if (parts.length !== 2 || parts[0] !== "HMAC") {
    return { ok: false, error: "authorization header must be HMAC ts:sig" };
  }

  const [tsStr, sig] = parts[1].split(":");
  if (!tsStr || !sig) {
    return { ok: false, error: "authorization header must be HMAC ts:sig" };
  }

  const ts = Number(tsStr);
  if (!Number.isFinite(ts)) {
    return { ok: false, error: "timestamp is not a number" };
  }

  if (Math.abs(now - ts) > WINDOW_SECONDS) {
    return { ok: false, error: "timestamp outside 300 second window" };
  }

  const bodyHash = createHmac("sha256", opts.secret).update(opts.body).digest("hex");
  const data = `${ts}.${opts.method}.${opts.path}.${bodyHash}`;
  const expected = createHmac("sha256", opts.secret).update(data).digest("hex");

  const sigBuf = Buffer.from(sig, "hex");
  const expectedBuf = Buffer.from(expected, "hex");
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    return { ok: false, error: "signature mismatch" };
  }

  return { ok: true };
}
