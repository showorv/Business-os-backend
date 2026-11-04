import { embedQuery, EMBEDDING_MODEL, toVectorLiteral } from "../../lib/embeddings.js";
import type { Prisma } from "../../lib/prisma.js";

const CANDIDATES = 30;
// The standard constant for combining rankings. Being near the top of a list counts for more.
const RANK_DAMPING = 60;
const MAX_CONTENT_CHARS = 1500;

// Words nearly every passage has. Matching these says nothing about meaning, yet each match pushes a
// passage up, so "কবে শেষ হবে" would find anything containing "হবে" before the contract it's asking about.
const COMMON_WORDS = new Set(
  `a an and are as at be been but by can could did do does for from had has have how i if in is it its may me must my of on or our
  shall should so that the their them they this to was we were what when where which who why will with would you your
  আমি আমার আমাদের আপনার তুমি তোমার সে তার এই এটি ওই কি কী কে কবে কত কয়টি কোন কেন কোথায় কিভাবে কীভাবে
  এবং ও বা না হয় হবে হয়েছে হচ্ছে ছিল আছে করা করে করতে করবে দিতে দিন দাও থেকে মধ্যে জন্য দিয়ে সাথে পর আগে নিয়ে`.split(/\s+/),
);

// The words worth matching exactly. Numbers and codes such as INV-2041 always count.
export const keywordsOf = (query: string) =>
  [...new Set(query.normalize("NFC").toLowerCase().split(/[^\p{L}\p{M}\p{N}-]+/u))].filter((word) => word.length > 1 && !COMMON_WORDS.has(word));

export interface SearchHit {
  documentId: string;
  fileName: string;
  documentType: string;
  page: number;
  heading: string | null;
  content: string;
  score: number;
}

interface Row {
  chunk_id: string;
  document_id: string;
  file_name: string;
  document_type: string;
  page: number;
  heading: string | null;
  content: string;
}

// Hybrid search: by meaning, which finds "lease" for "ভাড়ার চুক্তি", and by exact words, which finds an
// invoice number. A passage either list puts near the top rises. Filtered by business in the query, and
// again by the view, whose scope comes from the caller's session.
export const searchDocuments = async (
  tx: Prisma.TransactionClient,
  businessIds: string[],
  query: string,
  limit: number,
  documentTypes?: string[],
): Promise<SearchHit[]> => {
  const vector = toVectorLiteral(await embedQuery(query));
  const types = documentTypes?.length ? documentTypes : null;

  // Keeps searching past rows the business filter removes, rather than returning too few.
  await tx.$executeRaw`SELECT set_config('hnsw.iterative_scan', 'strict_order', true), set_config('hnsw.ef_search', '100', true)`;

  const byMeaning = await tx.$queryRaw<Row[]>`
    SELECT chunk_id, document_id, file_name, document_type, page, heading, content
    FROM ai_document_chunks
    WHERE business_id = ANY (${businessIds}::uuid[])
      AND embedding_model = ${EMBEDDING_MODEL}
      AND (${types}::text[] IS NULL OR document_type = ANY (${types}::text[]))
    ORDER BY embedding <=> ${vector}::vector
    LIMIT ${CANDIDATES}`;

  // Any of the words, rather than all of them, because questions have words documents don't.
  const keywords = keywordsOf(query).join(" ");
  const byWords = keywords
    ? await tx.$queryRaw<Row[]>`
        SELECT chunk_id, document_id, file_name, document_type, page, heading, content
        FROM ai_document_chunks,
          LATERAL (SELECT NULLIF(replace(plainto_tsquery('simple', ${keywords})::text, '&', '|'), '')::tsquery AS q) words
        WHERE business_id = ANY (${businessIds}::uuid[])
          AND (${types}::text[] IS NULL OR document_type = ANY (${types}::text[]))
          AND search @@ words.q
        ORDER BY ts_rank(search, words.q) DESC
        LIMIT ${CANDIDATES}`
    : [];

  const scores = new Map<string, { row: Row; score: number }>();
  for (const list of [byMeaning, byWords]) {
    list.forEach((row, rank) => {
      const existing = scores.get(row.chunk_id) ?? { row, score: 0 };
      existing.score += 1 / (RANK_DAMPING + rank + 1);
      scores.set(row.chunk_id, existing);
    });
  }

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ row, score }) => ({
      documentId: row.document_id,
      fileName: row.file_name,
      documentType: row.document_type,
      page: row.page,
      heading: row.heading,
      content: row.content.slice(0, MAX_CONTENT_CHARS),
      score: Number(score.toFixed(5)),
    }));
};
