import { api, putFile, runPendingEvents, type FinanceSetup } from "./api.js";

export const uploadStatement = async (f: FinanceSetup, text: string | Buffer, mime = "text/csv", fileName = "statement.csv") => {
  const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text, "utf8");
  const created = await api().post(`${f.base}/documents/uploads`).set("Authorization", f.auth).send({ type: "STATEMENT", fileName, mime, sizeBytes: bytes.length });
  if (created.status !== 201) throw new Error(`upload failed: ${JSON.stringify(created.body)}`);
  const put = await putFile(created.body.data.uploadUrl, bytes, mime);
  if (!put.ok) throw new Error(`put failed: ${put.status}`);
  return api().post(`${f.base}/documents/${created.body.data.document.id}/complete`).set("Authorization", f.auth);
};

export const MAPPING = { dateColumn: "Date", dateFormat: "DD/MM/YYYY", descriptionColumn: "Details", referenceColumn: "Ref", debitColumn: "Debit", creditColumn: "Credit", balanceColumn: "Balance" };

export const HEADER = "Date,Details,Ref,Debit,Credit,Balance";

// Uploads, imports, runs the worker's job inline, and returns the finished import.
export const importStatement = async (f: FinanceSetup, text: string, accountId = f.bankId, mapping: object = MAPPING) => {
  const document = await uploadStatement(f, text);
  if (document.status !== 200) throw new Error(`document failed: ${JSON.stringify(document.body)}`);
  const requested = await api().post(`${f.base}/statement-imports`).set("Authorization", f.auth).send({ documentId: document.body.data.id, financialAccountId: accountId, mapping });
  if (requested.status !== 202) throw new Error(`import failed: ${JSON.stringify(requested.body)}`);
  await runPendingEvents();
  const finished = await api().get(`${f.base}/statement-imports/${requested.body.data.id}`).set("Authorization", f.auth);
  return finished.body.data as { id: string; status: string; newLines: number; duplicateRows: number; failedRows: number; balanceBreaks: number; totalRows: number; errorCode: string | null; rowErrors: unknown[] };
};

export const linesOf = async (f: FinanceSetup, query = "") => {
  const res = await api().get(`${f.base}/statement-lines?limit=100${query}`).set("Authorization", f.auth);
  return res.body.data.items as { id: string; status: string; matchedBy: string | null; description: string | null; amountMinor: string; direction: string; lastMatchError: string | null }[];
};
