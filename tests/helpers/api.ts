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
