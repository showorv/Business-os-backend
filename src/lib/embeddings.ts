import path from "node:path";
import { env } from "../app/config/env.config.js";

// Runs on this machine, so document text never leaves it to be indexed, and each document costs nothing.
// This model was trained on many languages including Bengali, so a Bangla question can find an English
// passage and the other way round. Changing it means re-indexing, and its 384 numbers fit the database
// column; a model with a different size also needs a migration.
export const EMBEDDING_MODEL = "Xenova/multilingual-e5-small";
export const EMBEDDING_DIMENSIONS = 384;

type Extractor = (text: string[], options: { pooling: "mean"; normalize: boolean }) => Promise<{ tolist(): number[][] }>;

let loading: Promise<Extractor> | null = null;

// Loaded on first use, because it takes hundreds of MB and the API may never need it.
const getExtractor = () => {
  loading ??= (async () => {
    const { pipeline, env: settings } = await import("@huggingface/transformers");
    settings.cacheDir = path.resolve(env.MODEL_CACHE_DIR, "models");
    return (await pipeline("feature-extraction", EMBEDDING_MODEL, { dtype: "q8" })) as unknown as Extractor;
  })().catch((error: unknown) => {
    // A failed download mustn't stick: the next attempt can try again.
    loading = null;
    throw error;
  });
  return loading;
};

const BATCH_SIZE = 16;

// This model expects these prefixes: it treats what's being searched and what's searched for differently.
const embed = async (texts: string[], prefix: "passage: " | "query: ") => {
  const extractor = await getExtractor();
  const vectors: number[][] = [];
  for (let start = 0; start < texts.length; start += BATCH_SIZE) {
    const batch = texts.slice(start, start + BATCH_SIZE).map((text) => `${prefix}${text}`);
    vectors.push(...(await extractor(batch, { pooling: "mean", normalize: true })).tolist());
  }
  return vectors;
};

export const embedPassages = (texts: string[]) => embed(texts, "passage: ");
export const embedQuery = async (text: string) => (await embed([text], "query: "))[0]!;

// How a vector travels to PostgreSQL.
export const toVectorLiteral = (vector: number[]) => `[${vector.join(",")}]`;
