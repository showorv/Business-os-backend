import { generate } from "otplib";
import request from "supertest";
import app from "../../src/app.js";

export const API = "/api/v1";
export const PASSWORD = "correct-horse-battery";
export const ORIGIN = "http://localhost:5173";

export const api = () => request(app);

let counter = 0;
export const uniqueEmail = () => `user${++counter}@example.com`;

export interface Session {
  accessToken: string;
  csrfToken: string;
  refreshCookie: string;
  csrfCookie: string;
  email: string;
  userId: string;
}

const cookieValue = (res: request.Response, name: string) => {
  const cookies = res.get("Set-Cookie") ?? [];
  const match = cookies.find((cookie) => cookie.startsWith(`${name}=`));
  if (!match) throw new Error(`cookie ${name} not set`);
  return match.split(";")[0]!;
};

export const toSession = (res: request.Response, email: string): Session => ({
  accessToken: res.body.data.accessToken,
  csrfToken: res.body.data.csrfToken,
  refreshCookie: cookieValue(res, "refresh_token"),
  csrfCookie: cookieValue(res, "csrf_token"),
  email,
  userId: res.body.data.user.id,
});

export const registerUser = async (email = uniqueEmail(), password = PASSWORD) => {
  const res = await api().post(`${API}/auth/register`).send({ name: "Test User", email, password });
  if (res.status !== 201) throw new Error(`register failed: ${JSON.stringify(res.body)}`);
  return toSession(res, email);
};

export const bearer = (session: Pick<Session, "accessToken">) => `Bearer ${session.accessToken}`;

export const refreshRequest = (session: Session) =>
  api()
    .post(`${API}/auth/refresh`)
    .set("Cookie", [session.refreshCookie, session.csrfCookie])
    .set("X-CSRF-Token", session.csrfToken);

// A code from the next time step, for when the current step's code has already been used.
export const totpCode = (secret: string, offsetSeconds = 0) =>
  generate({ secret, epoch: Math.floor(Date.now() / 1000) + offsetSeconds });

export const enableMfa = async (session: Session, password = PASSWORD) => {
  const setup = await api()
    .post(`${API}/auth/mfa/setup`)
    .set("Authorization", bearer(session))
    .send({ password });
  if (setup.status !== 200) throw new Error(`mfa setup failed: ${JSON.stringify(setup.body)}`);
  const secret: string = setup.body.data.secret;

  const confirm = await api()
    .post(`${API}/auth/mfa/confirm`)
    .set("Authorization", bearer(session))
    .send({ code: await totpCode(secret) });
  if (confirm.status !== 200) throw new Error(`mfa confirm failed: ${JSON.stringify(confirm.body)}`);
  return secret;
};

export const createBusiness = async (owner: Session, name = "Acme Traders") => {
  const res = await api()
    .post(`${API}/businesses`)
    .set("Authorization", bearer(owner))
    .send({ name, type: "RETAIL" });
  if (res.status !== 201) throw new Error(`create business failed: ${JSON.stringify(res.body)}`);
  return res.body.data as { id: string; workspaceId: string; name: string };
};

// Registers a new user and brings them into the business with this role.
export const addMember = async (owner: Session, businessId: string, roleKey: string) => {
  const member = await registerUser();
  const invite = await api()
    .post(`${API}/businesses/${businessId}/invitations`)
    .set("Authorization", bearer(owner))
    .send({ email: member.email, roleKey });
  if (invite.status !== 201) throw new Error(`invite failed: ${JSON.stringify(invite.body)}`);

  const accepted = await api()
    .post(`${API}/invitations/accept`)
    .set("Authorization", bearer(member))
    .send({ token: invite.body.data.token });
  if (accepted.status !== 200) throw new Error(`accept failed: ${JSON.stringify(accepted.body)}`);
  return { ...member, memberId: accepted.body.data.memberId as string };
};

export interface FinanceSetup {
  owner: Session;
  auth: string;
  businessId: string;
  base: string;
  cashId: string;
  bankId: string;
  salesId: string;
  rentId: string;
}

// A business with its seeded Cash account and categories, plus a bank account.
export const setupFinance = async (): Promise<FinanceSetup> => {
  const owner = await registerUser();
  const auth = bearer(owner);
  const business = await createBusiness(owner);
  const base = `${API}/businesses/${business.id}`;

  // Fixed dates in these tests must always land in an open year, whatever today's date is.
  await api().post(`${base}/fiscal-periods/years`).set("Authorization", auth).send({ fiscalYear: 2026 });

  const accounts = await api().get(`${base}/accounts`).set("Authorization", auth);
  const categories = await api().get(`${base}/categories`).set("Authorization", auth);
  const bank = await api().post(`${base}/accounts`).set("Authorization", auth).send({ name: "City Bank", type: "BANK" });
  const named = (name: string) => categories.body.data.find((item: { name: string }) => item.name === name).id as string;

  return {
    owner,
    auth,
    businessId: business.id,
    base,
    cashId: accounts.body.data[0].id,
    bankId: bank.body.data.id,
    salesId: named("Sales"),
    rentId: named("Rent"),
  };
};

// The smallest bytes that really are a PDF and a PNG, for upload tests.
export const PDF_BYTES = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");
export const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

export const putFile = (uploadUrl: string, bytes: Buffer, mime: string) =>
  fetch(uploadUrl, { method: "PUT", body: new Uint8Array(bytes), headers: { "Content-Type": mime } });

// Runs the whole upload flow and returns the finished document.
export const uploadDocument = async (base: string, auth: string, bytes = PDF_BYTES, mime = "application/pdf") => {
  const created = await api()
    .post(`${base}/documents/uploads`)
    .set("Authorization", auth)
    .send({ type: "RECEIPT", fileName: "receipt.pdf", mime, sizeBytes: bytes.length });
  if (created.status !== 201) throw new Error(`upload failed: ${JSON.stringify(created.body)}`);
  const put = await putFile(created.body.data.uploadUrl, bytes, mime);
  if (!put.ok) throw new Error(`put failed: ${put.status}`);

  const done = await api().post(`${base}/documents/${created.body.data.document.id}/complete`).set("Authorization", auth);
  if (done.status !== 200) throw new Error(`complete failed: ${JSON.stringify(done.body)}`);
  return done.body.data as { id: string; sha256: string };
};

export interface LedgerLine {
  code: string;
  debit: string;
  credit: string;
}

// A journal's lines in a compact form, e.g. { code: "6100", debit: "3000000", credit: "0" }.
export const journalLines = async (base: string, auth: string, journalId: string): Promise<LedgerLine[]> => {
  const res = await api().get(`${base}/journals/${journalId}`).set("Authorization", auth);
  if (res.status !== 200) throw new Error(`journal failed: ${JSON.stringify(res.body)}`);
  return res.body.data.lines.map((line: { ledgerAccount: { code: string }; debitMinor: string; creditMinor: string }) => ({
    code: line.ledgerAccount.code,
    debit: line.debitMinor,
    credit: line.creditMinor,
  }));
};

export const ledgerIdByCode = async (base: string, auth: string, code: string) => {
  const res = await api().get(`${base}/ledger-accounts`).set("Authorization", auth);
  return res.body.data.find((account: { code: string }) => account.code === code).id as string;
};

// What the worker does, run inline so a test can check the result straight away.
export const runPendingEvents = async () => {
  const { prisma } = await import("../../src/lib/prisma.js");
  const { processEvent } = await import("../../src/app/jobs/processEvent.js");
  const events = await prisma.outboxEvent.findMany({ where: { publishedAt: null }, orderBy: { id: "asc" } });
  for (const event of events) {
    await prisma.outboxEvent.update({ where: { id: event.id }, data: { publishedAt: new Date() } });
    await processEvent({
      eventId: event.id.toString(),
      type: event.type,
      workspaceId: event.workspaceId,
      businessId: event.businessId,
      actorUserId: event.actorUserId,
      payload: event.payload as Record<string, string>,
    });
  }
  return events.length;
};
