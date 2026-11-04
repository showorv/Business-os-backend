import { createHash } from "node:crypto";

export const EMBEDDING_MODEL = "test/fake-embeddings";
export const EMBEDDING_DIMENSIONS = 384;

// A vector built from the words in the text, so texts sharing words are close, as with a real model.
const fakeVector = (text: string) => {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
    const hash = createHash("sha256").update(word).digest();
    vector[hash.readUInt16BE(0) % EMBEDDING_DIMENSIONS]! += 1;
  }
  const size = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / size || 0.0001);
};

export const embedPassages = async (texts: string[]) => texts.map(fakeVector);
export const embedQuery = async (text: string) => fakeVector(text);
export const toVectorLiteral = (vector: number[]) => `[${vector.join(",")}]`;
