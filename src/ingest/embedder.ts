export interface EmbedCfg {
  baseUrl: string;
  modelId: string;
  dimensions: number;
  apiKey: string;
}

export interface EmbedResult {
  vectors: number[][];
  model_id: string;
  dim: number;
}

interface EmbeddingResponse {
  data?: Array<{ embedding: number[] }>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function embedBatchOnce(
  texts: string[],
  cfg: EmbedCfg
): Promise<number[][]> {
  const response = await fetch(cfg.baseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.modelId,
      input: texts,
      dimensions: cfg.dimensions,
    }),
  });

  if (response.status === 401 || response.status === 402) {
    throw new Error(`terminal embedding error: HTTP ${response.status}`);
  }

  if (response.status === 429) {
    throw new Error(`rate limited: HTTP ${response.status}`);
  }

  if (!response.ok) {
    throw new Error(`embedding request failed: HTTP ${response.status}`);
  }

  const json = (await response.json()) as EmbeddingResponse;
  if (!Array.isArray(json.data)) {
    throw new Error("embedding response missing data array");
  }

  const vectors = json.data.map((item) => item.embedding);
  for (const vector of vectors) {
    if (vector.length !== cfg.dimensions) {
      throw new Error(
        `dimension mismatch: expected ${cfg.dimensions}, got ${vector.length}`
      );
    }
  }

  return vectors;
}

export async function embedBatch(
  texts: string[],
  cfg: EmbedCfg
): Promise<EmbedResult> {
  const BATCH_SIZE = 64;
  const MAX_RETRIES = 3;
  const vectors: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        const batchVectors = await embedBatchOnce(batch, cfg);
        vectors.push(...batchVectors);
        lastError = undefined;
        break;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const message = lastError.message;
        const isRateLimited = message.includes("rate limited");
        if (!isRateLimited || attempt === MAX_RETRIES) {
          throw lastError;
        }
        await sleep(2 ** attempt * 1000);
      }
    }

    if (lastError) {
      throw lastError;
    }
  }

  return {
    vectors,
    model_id: cfg.modelId,
    dim: cfg.dimensions,
  };
}
