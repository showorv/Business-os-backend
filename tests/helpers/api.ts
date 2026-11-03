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
