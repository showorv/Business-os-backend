import type { PageText } from "./extractText.js";

// The document suggests about 800 tokens, but this embedding model reads at most 512 and ignores the
// rest. About 300 words keeps each passage whole within that, in English or Bangla.
const CHUNK_WORDS = 300;
const OVERLAP_WORDS = 40;
const MAX_HEADING_LENGTH = 80;

export interface Chunk {
  chunkIndex: number;
  page: number;
  heading: string | null;
  content: string;
}

// A short line that doesn't end like a sentence, followed by more text.
const looksLikeHeading = (line: string) =>
  line.length > 2 && line.length <= MAX_HEADING_LENGTH && !/[.,;:।?!]$/.test(line) && /[\p{L}]/u.test(line) && line.split(/\s+/).length <= 10;

export const chunkPages = (pages: PageText[]) => {
  const chunks: Chunk[] = [];
  let heading: string | null = null;

  for (const { page, text } of pages) {
    const lines = text.normalize("NFC").split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
    let words: string[] = [];
    let chunkHeading = heading;

    const flush = () => {
      if (words.length === 0) return;
      chunks.push({ chunkIndex: chunks.length, page, heading: chunkHeading, content: words.join(" ") });
      // The next passage repeats the end of this one, so a sentence split between them can still be found.
      words = words.slice(-OVERLAP_WORDS);
    };

    for (const line of lines) {
      if (looksLikeHeading(line)) {
        heading = line;
        if (words.length === 0) chunkHeading = line;
      }
      for (const word of line.split(" ")) {
        words.push(word);
        if (words.length >= CHUNK_WORDS) {
          flush();
          chunkHeading = heading;
        }
      }
    }
    // Only a leftover that adds something new: not just the overlap of the passage before it.
    const isOnlyOverlap = chunks.at(-1)?.page === page && words.length <= OVERLAP_WORDS && chunks.at(-1)!.content.endsWith(words.join(" "));
    if (!isOnlyOverlap) flush();
  }
  return chunks;
};
