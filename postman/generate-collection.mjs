// Builds Business_OS.postman_collection.json. Edit this file, not the JSON, then run:
//   npm run postman:build
import fs from "node:fs";

const out = new URL("./Business_OS.postman_collection.json", import.meta.url);

// Runs before every request. Requests named "[TOTP]" get a fresh, never-used code in {{totp}}.
const collectionPre = `
if (pm.info.requestName.includes("[TOTP]")) {
  const secret = pm.collectionVariables.get("mfaSecret");
  const bytes = [];
  let bits = "";
  for (const ch of secret.replace(/=+$/, "")) {
    bits += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(ch).toString(2).padStart(5, "0");
  }
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2).toString(16).padStart(2, "0"));
  const totpFor = (step) => {
    const key = CryptoJS.enc.Hex.parse(bytes.join(""));
    const msg = CryptoJS.enc.Hex.parse(step.toString(16).padStart(16, "0"));
    const hex = CryptoJS.HmacSHA1(msg, key).toString();
    const offset = parseInt(hex.slice(-1), 16);
    const value = parseInt(hex.substr(offset * 2, 8), 16) & 0x7fffffff;
    return String(value % 1000000).padStart(6, "0");
  };
  // The API accepts one step either side of now, and each step only once.
  const last = Number(pm.collectionVariables.get("lastTotpStep") || 0);
  const current = Math.floor(Date.now() / 30000);
  let step = [current - 1, current, current + 1].find((s) => s > last);
  let waitMs = 0;
  if (step === undefined) {
    step = last + 1;
    waitMs = (step - 1) * 30000 - Date.now() + 500;
  }
  pm.collectionVariables.set("lastTotpStep", String(step));
  pm.collectionVariables.set("totp", totpFor(step));
  if (waitMs > 0) setTimeout(() => {}, waitMs);
}
`;

const status = (code) => `pm.test("status is ${code}", () => pm.response.to.have.status(${code}));`;
const errCode = (code) => `pm.test("error code is ${code}", () => pm.expect(pm.response.json().error.code).to.eql("${code}"));`;
const saveAuth = `const d = pm.response.json().data;
pm.test("returns tokens", () => { pm.expect(d.accessToken).to.be.a("string"); pm.expect(d.csrfToken).to.be.a("string"); pm.expect(d.refreshToken).to.eql(undefined); });
pm.collectionVariables.set("accessToken", d.accessToken);
pm.collectionVariables.set("csrfToken", d.csrfToken);`;

const req = (name, method, path, { auth, body, csrf, tests = [], pre, headers = [], raw } = {}) => ({
  name,
  event: [
    ...(pre ? [{ listen: "prerequest", script: { type: "text/javascript", exec: pre.split("\n") } }] : []),
    { listen: "test", script: { type: "text/javascript", exec: tests.join("\n").split("\n") } },
  ],
  request: {
    method,
    auth: auth ? { type: "bearer", bearer: [{ key: "token", value: auth === true ? "{{accessToken}}" : auth, type: "string" }] } : { type: "noauth" },
    header: [
      ...(body || raw ? [{ key: "Content-Type", value: "application/json" }] : []),
      ...(csrf ? [{ key: "X-CSRF-Token", value: "{{csrfToken}}" }] : []),
      ...headers,
    ],
    ...(body ? { body: { mode: "raw", raw: JSON.stringify(body, null, 2) } } : {}),
    ...(raw ? { body: { mode: "raw", raw } } : {}),
    url: `{{baseUrl}}${path}`,
  },
});

const A = "/api/v1/auth", U = "/api/v1/users", AU = "/api/v1/audit", B = "/api/v1/businesses";
const BIZ = `${B}/{{businessId}}`;
const creds = (password = "{{password}}") => ({ email: "{{email}}", password });

const item = [
  { name: "1. Platform", item: [
    req("Health", "GET", "/health", { tests: [status(200)] }),
    req("Readiness", "GET", "/health/ready", { tests: [status(200), `pm.test("database and redis up", () => pm.expect(pm.response.json().data).to.eql({ database: true, redis: true }));`] }),
    req("OpenAPI spec", "GET", "/api/docs/openapi.json", { tests: [status(200), `pm.test("documents the API", () => pm.expect(pm.response.json().paths).to.have.property("/api/v1/auth/login"));`] }),
    req("Unknown route", "GET", "/api/v1/nope", { tests: [status(404), errCode("NOT_FOUND")] }),
  ]},
  { name: "2. Register & login", item: [
    req("Register", "POST", `${A}/register`, {
      pre: `pm.collectionVariables.set("email", "postman" + Date.now() + "@example.com");`,
      body: { name: "Postman User", email: "{{email}}", password: "{{password}}" },
      tests: [status(201), saveAuth],
    }),
    req("Register - duplicate email", "POST", `${A}/register`, { body: { name: "Dup", email: "{{email}}", password: "{{password}}" }, tests: [status(409), errCode("EMAIL_TAKEN")] }),
    req("Register - invalid body", "POST", `${A}/register`, { body: { name: "", email: "nope", password: "short" }, tests: [status(422), errCode("VALIDATION_FAILED")] }),
    req("Login - wrong password", "POST", `${A}/login`, { body: creds("wrong-password-here"), tests: [status(401), errCode("INVALID_CREDENTIALS")] }),
    req("Login", "POST", `${A}/login`, { body: creds(), tests: [status(200), saveAuth, `pm.test("mfaRequired is false", () => pm.expect(d.mfaRequired).to.eql(false));`] }),
  ]},
  { name: "3. Users", item: [
    req("Get me - no token", "GET", `${U}/me`, { tests: [status(401), errCode("UNAUTHENTICATED")] }),
    req("Get me", "GET", `${U}/me`, { auth: true, tests: [status(200), `pm.test("no secrets", () => { const u = pm.response.json().data; pm.expect(u.email).to.eql(pm.collectionVariables.get("email")); pm.expect(u.passwordHash).to.eql(undefined); });`] }),
    req("Update me", "PATCH", `${U}/me`, { auth: true, body: { name: "সোহরাব", locale: "bn-BD", digitStyle: "bangla" }, tests: [status(200), `pm.test("saved", () => { const u = pm.response.json().data; pm.expect(u.locale).to.eql("bn-BD"); pm.expect(u.digitStyle).to.eql("bangla"); pm.expect(u.name).to.eql("সোহরাব"); });`] }),
    req("Update me - bad locale", "PATCH", `${U}/me`, { auth: true, body: { locale: "fr" }, tests: [status(422)] }),
  ]},
  { name: "4. Audit", item: [
    req("My audit trail", "GET", `${AU}/me?limit=2`, { auth: true, tests: [status(200), `const j = pm.response.json();
pm.test("newest first, paginated, no hashes", () => { pm.expect(j.data.length).to.eql(2); pm.expect(j.data[0].action).to.eql("user.updated"); pm.expect(j.data[0].rowHash).to.eql(undefined); pm.expect(j.meta.nextCursor).to.be.a("string"); });
pm.collectionVariables.set("auditCursor", j.meta.nextCursor);`] }),
    req("My audit trail - next page", "GET", `${AU}/me?limit=2&cursor={{auditCursor}}`, { auth: true, tests: [status(200), `pm.test("has rows", () => pm.expect(pm.response.json().data.length).to.be.above(0));`] }),
    req("My audit trail - bad cursor", "GET", `${AU}/me?cursor=abc`, { auth: true, tests: [status(422)] }),
  ]},
  { name: "5. Sessions", item: [
    req("List sessions", "GET", `${A}/sessions`, { auth: true, tests: [status(200), `const s = pm.response.json().data;
pm.test("two devices, one current", () => { pm.expect(s.length).to.eql(2); pm.expect(s.filter((x) => x.current).length).to.eql(1); });
pm.collectionVariables.set("otherSessionId", s.find((x) => !x.current).id);`] }),
    req("Revoke other session", "DELETE", `${A}/sessions/{{otherSessionId}}`, { auth: true, tests: [status(200)] }),
    req("Revoke same session again", "DELETE", `${A}/sessions/{{otherSessionId}}`, { auth: true, tests: [status(404), errCode("NOT_FOUND")] }),
    req("Revoke - invalid id", "DELETE", `${A}/sessions/not-a-uuid`, { auth: true, tests: [status(422)] }),
  ]},
  { name: "6. Refresh", item: [
    req("Refresh - no CSRF header", "POST", `${A}/refresh`, { tests: [status(403), errCode("CSRF_FAILED")] }),
    req("Refresh - foreign Origin", "POST", `${A}/refresh`, { csrf: true, headers: [{ key: "Origin", value: "https://evil.example" }], tests: [status(403), errCode("CSRF_FAILED")] }),
    req("Refresh", "POST", `${A}/refresh`, { csrf: true, tests: [status(200), saveAuth] }),
    req("Access token still works after refresh", "GET", `${U}/me`, { auth: true, tests: [status(200)] }),
  ]},
  { name: "7. MFA", item: [
    req("Setup - wrong password", "POST", `${A}/mfa/setup`, { auth: true, body: { password: "wrong-password-here" }, tests: [status(401), errCode("INVALID_CREDENTIALS")] }),
    req("Setup", "POST", `${A}/mfa/setup`, { auth: true, body: { password: "{{password}}" }, tests: [status(200), `const m = pm.response.json().data;
pm.test("returns secret and URI", () => pm.expect(m.otpauthUri).to.include("otpauth://totp/"));
pm.collectionVariables.set("mfaSecret", m.secret);
pm.collectionVariables.set("lastTotpStep", "0");`] }),
    req("Confirm - wrong code", "POST", `${A}/mfa/confirm`, { auth: true, body: { code: "000000" }, tests: [status(401), errCode("MFA_INVALID_CODE")] }),
    req("Confirm [TOTP]", "POST", `${A}/mfa/confirm`, { auth: true, body: { code: "{{totp}}" }, tests: [status(200)] }),
    req("Change password - MFA not recent", "POST", `${A}/change-password`, { auth: true, body: { currentPassword: "{{password}}", newPassword: "{{newPassword}}" }, tests: [status(401), errCode("MFA_REQUIRED")] }),
    req("Login - returns challenge", "POST", `${A}/login`, { body: creds(), tests: [status(200), `const c = pm.response.json().data;
pm.test("challenge, no tokens", () => { pm.expect(c.mfaRequired).to.eql(true); pm.expect(c.accessToken).to.eql(undefined); });
pm.collectionVariables.set("challengeToken", c.challengeToken);`] }),
    req("MFA verify - wrong code", "POST", `${A}/mfa/verify`, { body: { challengeToken: "{{challengeToken}}", code: "000000" }, tests: [status(401), errCode("MFA_INVALID_CODE")] }),
    req("MFA verify - bad challenge", "POST", `${A}/mfa/verify`, { body: { challengeToken: "garbage", code: "123456" }, tests: [status(401), errCode("MFA_CHALLENGE_INVALID")] }),
    req("MFA verify [TOTP]", "POST", `${A}/mfa/verify`, { body: { challengeToken: "{{challengeToken}}", code: "{{totp}}" }, tests: [status(200), saveAuth] }),
    req("Step-up [TOTP]", "POST", `${A}/mfa/step-up`, { auth: true, body: { code: "{{totp}}" }, tests: [status(200), `const t = pm.response.json().data;
pm.test("new access token", () => pm.expect(t.accessToken).to.be.a("string"));
pm.collectionVariables.set("accessToken", t.accessToken);`] }),
    req("Disable - wrong code", "POST", `${A}/mfa/disable`, { auth: true, body: { password: "{{password}}", code: "000000" }, tests: [status(401), errCode("MFA_INVALID_CODE")] }),
    req("Disable [TOTP] (may wait up to 30s)", "POST", `${A}/mfa/disable`, { auth: true, body: { password: "{{password}}", code: "{{totp}}" }, tests: [status(200)] }),
  ]},
  { name: "8. Change password", item: [
    req("Change password - wrong current", "POST", `${A}/change-password`, { auth: true, body: { currentPassword: "not-my-password", newPassword: "{{newPassword}}" }, tests: [status(401), errCode("INVALID_CREDENTIALS")] }),
    req("Change password", "POST", `${A}/change-password`, { auth: true, body: { currentPassword: "{{password}}", newPassword: "{{newPassword}}" }, tests: [status(200)] }),
    req("Old token is dead", "GET", `${U}/me`, { auth: true, tests: [status(401)] }),
    req("Login - old password fails", "POST", `${A}/login`, { body: creds(), tests: [status(401), errCode("INVALID_CREDENTIALS")] }),
    req("Login - new password", "POST", `${A}/login`, { body: creds("{{newPassword}}"), tests: [status(200), saveAuth] }),
  ]},
  { name: "9. Logout", item: [
    req("Logout", "POST", `${A}/logout`, { csrf: true, tests: [status(200)] }),
    req("Token dead after logout", "GET", `${U}/me`, { auth: true, tests: [status(401)] }),
    req("Login again", "POST", `${A}/login`, { body: creds("{{newPassword}}"), tests: [status(200), saveAuth] }),
    req("Logout all", "POST", `${A}/logout-all`, { auth: true, tests: [status(200)] }),
    req("Token dead after logout-all", "GET", `${U}/me`, { auth: true, tests: [status(401)] }),
  ]},

  // Phase 2. Three fresh users: Owner, Invitee and an Outsider who belongs to nothing.
  { name: "10. Business setup", item: [
    req("Register owner", "POST", `${A}/register`, {
      pre: `pm.collectionVariables.set("ownerEmail", "owner" + Date.now() + "@example.com");`,
      body: { name: "Owner", email: "{{ownerEmail}}", password: "{{password}}" },
      tests: [status(201), `pm.collectionVariables.set("ownerToken", pm.response.json().data.accessToken);`],
    }),
    req("Register invitee", "POST", `${A}/register`, {
      pre: `pm.collectionVariables.set("inviteeEmail", "invitee" + Date.now() + "@example.com");`,
      body: { name: "Invitee", email: "{{inviteeEmail}}", password: "{{password}}" },
      tests: [status(201), `pm.collectionVariables.set("inviteeToken", pm.response.json().data.accessToken);`],
    }),
    req("Register outsider", "POST", `${A}/register`, {
      pre: `pm.collectionVariables.set("outsiderEmail", "outsider" + Date.now() + "@example.com");`,
      body: { name: "Outsider", email: "{{outsiderEmail}}", password: "{{password}}" },
      tests: [status(201), `pm.collectionVariables.set("outsiderToken", pm.response.json().data.accessToken);`],
    }),
    req("List roles", "GET", "/api/v1/roles", { auth: "{{ownerToken}}", tests: [status(200), `pm.test("five system roles", () => pm.expect(pm.response.json().data.map((r) => r.key)).to.eql(["OWNER", "ADMIN", "ACCOUNTANT", "MANAGER", "VIEWER"]));`] }),
  ]},
  { name: "11. Businesses", item: [
    req("Create - invalid body", "POST", B, { auth: "{{ownerToken}}", body: { name: "Acme", type: "RETAIL", baseCurrency: "XXQ" }, tests: [status(422), errCode("VALIDATION_FAILED")] }),
    req("Create", "POST", B, { auth: "{{ownerToken}}", body: { name: "Acme Traders", type: "RETAIL" }, tests: [status(201), `const b = pm.response.json().data;
pm.test("defaults applied", () => { pm.expect(b.baseCurrency).to.eql("BDT"); pm.expect(b.status).to.eql("ACTIVE"); pm.expect(b.settings.version).to.eql(1); });
pm.collectionVariables.set("businessId", b.id);`] }),
    req("List mine", "GET", B, { auth: "{{ownerToken}}", tests: [status(200), `pm.test("one business, as owner", () => { const l = pm.response.json().data; pm.expect(l.length).to.eql(1); pm.expect(l[0].roleKey).to.eql("OWNER"); });`] }),
    req("Get one", "GET", BIZ, { auth: "{{ownerToken}}", tests: [status(200), `pm.test("includes my permissions", () => pm.expect(pm.response.json().data.membership.permissions).to.include("business.manage"));`] }),
    req("Update", "PATCH", BIZ, { auth: "{{ownerToken}}", body: { name: "Acme Renamed", settings: { locale: "bn-BD" } }, tests: [status(200), `pm.test("saved and merged", () => { const b = pm.response.json().data; pm.expect(b.name).to.eql("Acme Renamed"); pm.expect(b.settings.locale).to.eql("bn-BD"); pm.expect(b.settings.transactionPrefix).to.eql("TXN"); });`] }),
    req("Outsider gets 404", "GET", BIZ, { auth: "{{outsiderToken}}", tests: [status(404), errCode("NOT_FOUND")] }),
    req("Outsider list is empty", "GET", B, { auth: "{{outsiderToken}}", tests: [status(200), `pm.test("nothing visible", () => pm.expect(pm.response.json().data.length).to.eql(0));`] }),
  ]},
  { name: "12. Invitations", item: [
    req("Invite", "POST", `${BIZ}/invitations`, { auth: "{{ownerToken}}", body: { email: "{{inviteeEmail}}", roleKey: "VIEWER" }, tests: [status(201), `const i = pm.response.json().data;
pm.test("returns the token once", () => pm.expect(i.token).to.be.a("string"));
pm.collectionVariables.set("inviteToken", i.token);`] }),
    req("Invite as OWNER is refused", "POST", `${BIZ}/invitations`, { auth: "{{ownerToken}}", body: { email: "x@example.com", roleKey: "OWNER" }, tests: [status(422)] }),
    req("Invite to revoke", "POST", `${BIZ}/invitations`, { auth: "{{ownerToken}}", body: { email: "revoke-me@example.com", roleKey: "MANAGER" }, tests: [status(201), `pm.collectionVariables.set("revokeId", pm.response.json().data.id);`] }),
    req("List pending", "GET", `${BIZ}/invitations`, { auth: "{{ownerToken}}", tests: [status(200), `pm.test("two pending, no tokens", () => { const l = pm.response.json().data; pm.expect(l.length).to.eql(2); pm.expect(l[0].token).to.eql(undefined); });`] }),
    req("Revoke", "DELETE", `${BIZ}/invitations/{{revokeId}}`, { auth: "{{ownerToken}}", tests: [status(200)] }),
    req("Revoke again", "DELETE", `${BIZ}/invitations/{{revokeId}}`, { auth: "{{ownerToken}}", tests: [status(404)] }),
    req("Accept with the wrong account", "POST", "/api/v1/invitations/accept", { auth: "{{outsiderToken}}", body: { token: "{{inviteToken}}" }, tests: [status(403), errCode("INVITATION_EMAIL_MISMATCH")] }),
    req("Accept", "POST", "/api/v1/invitations/accept", { auth: "{{inviteeToken}}", body: { token: "{{inviteToken}}" }, tests: [status(200), `pm.collectionVariables.set("memberId", pm.response.json().data.memberId);`] }),
    req("Accept twice", "POST", "/api/v1/invitations/accept", { auth: "{{inviteeToken}}", body: { token: "{{inviteToken}}" }, tests: [status(404), errCode("INVITATION_INVALID")] }),
    req("Viewer cannot invite", "POST", `${BIZ}/invitations`, { auth: "{{inviteeToken}}", body: { email: "y@example.com", roleKey: "VIEWER" }, tests: [status(403), errCode("PERMISSION_DENIED")] }),
  ]},
  { name: "13. Members", item: [
    req("List members", "GET", `${BIZ}/members`, { auth: "{{inviteeToken}}", tests: [status(200), `const m = pm.response.json().data;
pm.test("owner and viewer", () => pm.expect(m.map((x) => x.roleKey)).to.eql(["OWNER", "VIEWER"]));
pm.collectionVariables.set("ownerMemberId", m[0].id);`] }),
    req("Viewer cannot change roles", "PATCH", `${BIZ}/members/{{memberId}}`, { auth: "{{inviteeToken}}", body: { roleKey: "ADMIN" }, tests: [status(403), errCode("PERMISSION_DENIED")] }),
    req("Grant optional finance.read", "PATCH", `${BIZ}/members/{{memberId}}`, { auth: "{{ownerToken}}", body: { extraPermissions: ["finance.read"] }, tests: [status(200)] }),
    req("Refuse a non-optional grant", "PATCH", `${BIZ}/members/{{memberId}}`, { auth: "{{ownerToken}}", body: { extraPermissions: ["ledger.post"] }, tests: [status(422), errCode("PERMISSION_NOT_GRANTABLE")] }),
    req("Change role", "PATCH", `${BIZ}/members/{{memberId}}`, { auth: "{{ownerToken}}", body: { roleKey: "ACCOUNTANT" }, tests: [status(200)] }),
    req("New role applies immediately", "GET", BIZ, { auth: "{{inviteeToken}}", tests: [status(200), `pm.test("now accountant", () => pm.expect(pm.response.json().data.membership.roleKey).to.eql("ACCOUNTANT"));`] }),
    req("Cannot demote the last owner", "PATCH", `${BIZ}/members/{{ownerMemberId}}`, { auth: "{{ownerToken}}", body: { roleKey: "ADMIN" }, tests: [status(409), errCode("LAST_OWNER")] }),
  ]},
  { name: "14. Business audit", item: [
    req("Business audit trail", "GET", `${BIZ}/audit?limit=5`, { auth: "{{ownerToken}}", tests: [status(200), `pm.test("newest first", () => pm.expect(pm.response.json().data[0].action).to.eql("member.updated"));`] }),
    req("Filter by action", "GET", `${BIZ}/audit?action=business.created`, { auth: "{{ownerToken}}", tests: [status(200), `pm.test("one row", () => pm.expect(pm.response.json().data.length).to.eql(1));`] }),
    req("Accountant cannot read it", "GET", `${BIZ}/audit`, { auth: "{{inviteeToken}}", tests: [status(403), errCode("PERMISSION_DENIED")] }),
  ]},
  { name: "15. Lifecycle & removal", item: [
    req("Deactivate", "POST", `${BIZ}/status`, { auth: "{{ownerToken}}", body: { status: "INACTIVE" }, tests: [status(200)] }),
    req("Inactive is read-only", "PATCH", BIZ, { auth: "{{ownerToken}}", body: { name: "Nope" }, tests: [status(409), errCode("BUSINESS_NOT_ACTIVE")] }),
    req("Inactive stays readable", "GET", BIZ, { auth: "{{ownerToken}}", tests: [status(200)] }),
    req("Reactivate", "POST", `${BIZ}/status`, { auth: "{{ownerToken}}", body: { status: "ACTIVE" }, tests: [status(200)] }),
    req("Remove member", "DELETE", `${BIZ}/members/{{memberId}}`, { auth: "{{ownerToken}}", tests: [status(200)] }),
    req("Removed member gets 404", "GET", BIZ, { auth: "{{inviteeToken}}", tests: [status(404), errCode("NOT_FOUND")] }),
    req("Archive", "POST", `${BIZ}/status`, { auth: "{{ownerToken}}", body: { status: "ARCHIVED" }, tests: [status(200)] }),
    req("Archived is hidden from the list", "GET", B, { auth: "{{ownerToken}}", tests: [status(200), `pm.test("hidden", () => pm.expect(pm.response.json().data.length).to.eql(0));`] }),
    req("Archived can be listed on request", "GET", `${B}?includeArchived=true`, { auth: "{{ownerToken}}", tests: [status(200), `pm.test("shown", () => pm.expect(pm.response.json().data.length).to.eql(1));`] }),
  ]},
];

fs.writeFileSync(out, JSON.stringify({
  info: { name: "Business OS API", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    description: "Run the whole collection in order with the Collection Runner. Each run registers a new user." },
  event: [{ listen: "prerequest", script: { type: "text/javascript", exec: collectionPre.trim().split("\n") } }],
  variable: [
    { key: "baseUrl", value: "http://localhost:5001" },
    { key: "password", value: "postman-test-password" },
    { key: "newPassword", value: "postman-new-password" },
  ],
  item,
}, null, 2) + "\n");
