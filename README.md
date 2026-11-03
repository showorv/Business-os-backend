# Business OS Backend

Node.js, Express 5, TypeScript, PostgreSQL (Prisma 7) and Redis. This is a modular monolith built phase by phase from the *Business OS — System Architecture* document. Use this file to track what is done and how it works.

## Progress

| Phase | Name | Status |
|---|---|---|
| **1** | **Foundation & auth** | ✅ **Done**, see [what still needs you](#what-still-needs-you) |
| 2 | Multi-business (businesses, members, RBAC, RLS) | ⬜ Next |
| 3 | Accounts & transactions | ⬜ |
| 4 | Double-entry ledger | ⬜ |
| 5 | Analytics & reports | ⬜ |
| 6 | Tasks & reminders (BullMQ, email) | ⬜ |
| 7 | Integrations (bKash, banks, CSV) | ⬜ |
| 8 | AI & RAG | ⬜ |
| 9 | Frontend | ⬜ |
| 10 | Hardening & launch | ⬜ |

## Run it

You need Docker Desktop running and Node. This was built and tested on Node 26.

**Step 1. Install packages**

```bash
npm install
```

**Step 2. Start Postgres, Redis and MinIO**

```bash
docker compose up -d --wait
```

**Step 3. Create your `.env`** (skip this if you already have one)

```bash
cp .env.example .env
```

Then fill in `JWT_ACCESS_SECRET`, `JWT_MFA_SECRET` and `MFA_ENCRYPTION_KEY`. The file explains how to generate each one. The app refuses to start if a value is missing or invalid, and it tells you which one.

**Step 4. Create the tables**

```bash
npm run db:deploy
```

**Step 5. Generate the Prisma client**

```bash
npm run db:generate
```

**Step 6. Start the API**

```bash
npm run dev
```

**Step 7. Check it**

- http://localhost:5001/health/ready should show `database: true` and `redis: true`
- http://localhost:5001/api/docs is Swagger UI, where you can try every endpoint (not served in production)

### Which database does `.env` use?

Your `.env` currently points to **Neon**, and the migration has **not** been applied there. Neon's database holds a demo table called `playing_with_neon`, and Prisma normally refuses to migrate a non-empty database that has no migration history. You have two options:

- **Use Neon:** drop that demo table if you don't need it, then run `npm run db:deploy`.
- **Use local Docker:** set both `DATABASE_URL` and `DIRECT_DATABASE_URL` to `postgresql://business_os:business_os@localhost:5432/business_os`.

Tests never touch Neon. They always use the local `business_os_test` database, and they stop with an error if pointed anywhere else.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Starts the API and restarts on file changes |
| `npm run build` then `npm start` | Production build and run |
| `npm test` | Runs all tests (needs Docker running) |
| `npm run lint` / `npm run typecheck` | Code checks |
| `npm run db:migrate` | Creates a new migration after you change `prisma/schema/*` |
| `npm run db:deploy` | Applies existing migrations |
| `npm run db:status` | Shows which migrations are applied |
| `npm run audit:verify` | Checks the audit hash chain; exits with 1 if it finds tampering |

## Folder structure

```
src/
├── server.ts              Starts the API and shuts it down cleanly
├── app.ts                 Express app: the middleware order lives here
├── instrument.ts          OpenTelemetry + Sentry, loaded before everything else
├── lib/                   prisma, redis, logger
├── scripts/verify-audit.ts
├── types/express.d.ts     Adds req.auth, req.requestId, req.validated
└── app/
    ├── config/            env.config.ts (validated environment)
    ├── routes/index.ts    Module registry: a new module = one line here
    ├── docs/openapi.ts    Swagger spec, built from the Zod schemas
    ├── middlewares/       requestId, requestLogger, rateLimit, auth, csrf, validate, errorHandler
    ├── utils/             errors, jwt, cookies, crypto, lockout, normalize, validationFields...
    └── modules/
        ├── auth/          auth.router / controller / service / validation / interface
        ├── users/         same five files
        └── audit/         same five files
prisma/
├── schema/                schema, workspace, auth and audit models
└── migrations/
tests/                     Integration tests against real Postgres and Redis
```

### The five files in every module

| File | Its only job |
|---|---|
| `*.router.ts` | URL + middleware chain |
| `*.validation.ts` | Zod schemas for body, query and params |
| `*.controller.ts` | Reads the request, calls the service, sends the response. No business rules |
| `*.service.ts` | Business rules, Prisma queries, transactions, audit |
| `*.interface.ts` | TypeScript types |

### How one request travels

```
Request
 → requestId      gives it an ID, returned as X-Request-Id
 → requestLogger  logs it with secrets redacted
 → helmet, cors   security headers and allowed origins
 → rateLimit      Redis counter, returns 429 when exceeded
 → json, cookies  1 MB body limit
 → router → requireAuth → validate → controller → service → PostgreSQL
 → errorHandler   turns any failure into a coded JSON error
```

## What was built in Phase 1

### Step 1. Project skeleton
TypeScript, ESLint, Vitest and npm scripts. Docker Compose runs Postgres (with pgvector, ready for Phase 8), Redis and MinIO (unused until Phase 3).

### Step 2. Environment validation
`env.config.ts` checks every variable with Zod at startup. A bad config stops the app immediately instead of failing later.

### Step 3. Database
| Table | Purpose |
|---|---|
| `workspaces`, `user_workspaces` | The tenant boundary. Each new user gets their own workspace |
| `users` | Login details, `locale`, `digit_style`, `token_version` |
| `mfa_factors` | Encrypted TOTP secret and the last used code step |
| `user_sessions` | One login on one device |
| `refresh_tokens` | Only hashes are stored; linked as a rotation family |
| `audit_logs` | Append-only, hash-chained history |

IDs are UUIDv7. Emails use `citext`, so `A@x.com` and `a@x.com` count as the same address. The triggers that protect `audit_logs` are written by hand in the migration because Prisma cannot express them.

### Step 4. Logging, tracing, error tracking
- **Pino** writes JSON logs and redacts passwords, tokens, cookies and codes.
- **OpenTelemetry** sends traces, metrics and logs when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
- **Sentry** receives unexpected errors when `SENTRY_DSN` is set. It is configured to send no headers, cookies or bodies, because those contain passwords and tokens.

Both integrations stay off until you set their variable.

### Step 5. Error format
The API returns codes, never sentences, so the frontend can translate them into English or Bangla:

```json
{ "success": false, "error": { "code": "INVALID_CREDENTIALS", "requestId": "..." } }
```

Validation errors also list `params.fields`, with each field's name and code. All codes are in `src/app/utils/errors.ts`.

### Step 6. Auth
**Login flow:**
1. The password is checked with bcrypt.
2. The response contains a 15-minute **access token**, and a **refresh token** is set in an httpOnly cookie.
3. The frontend keeps the access token in memory and sends it as `Authorization: Bearer ...`.

**Refresh rotation:** every refresh replaces the token. If an old token is ever used again, that means it may have been stolen, so the API ends that whole session, bumps `token_version` (which kills all the user's access tokens) and writes an audit record.

**MFA (TOTP):**
1. `POST /auth/mfa/setup` returns a secret and an `otpauth://` URI. The frontend shows the URI as a QR code.
2. `POST /auth/mfa/confirm` turns MFA on once a correct code is entered.
3. From then on, login returns a `challengeToken`, and `POST /auth/mfa/verify` finishes the login.
4. Sensitive actions need MFA proof from the last 10 minutes. Without it they return `MFA_REQUIRED`, and `POST /auth/mfa/step-up` provides the proof.

**Protections:**
| Threat | Control |
|---|---|
| Password guessing | 5 wrong passwords lock the account for 15 minutes, plus per-IP rate limits |
| Finding out who has an account | Login gives the same error and does the same work for unknown emails |
| Code guessing or reuse | 5 wrong codes lock MFA for 15 minutes; each code works only once |
| CSRF on cookie routes | SameSite=Strict, an Origin check and a double-submit token (`X-CSRF-Token` must match the `csrf_token` cookie) |
| Token forgery | The algorithm is fixed to HS256; access and MFA tokens use separate secrets and audiences |
| Disabled users, revoked sessions | Checked in the database on every request, so access ends immediately |
| Redis outage | The API keeps working without limits and `/health/ready` returns 503 |

To close sign-ups once your account exists, set `REGISTRATION_ENABLED=false`.

### Step 7. Users
Read and update your own profile, including language (`en` or `bn-BD`) and digit style (`latin` or `bangla`).

### Step 8. Audit
`auditService.record(tx, ...)` runs **inside the same database transaction** as the change, so both are saved or neither is. Database triggers reject UPDATE, DELETE and TRUNCATE on the table. Each row also stores a hash of the previous row, so `npm run audit:verify` can detect an edited or deleted row.

### Step 9. Bangla groundwork
- Errors are returned as codes (Step 5).
- `users.locale` and `users.digit_style` are stored.
- Text is saved in Unicode NFC form.
- Numeric input such as MFA codes accepts `০-৯`, stored as `0-9`.

### Step 10. Swagger and CI
Swagger UI is generated from the same Zod schemas that validate requests. `.github/workflows/ci.yml` runs lint, typecheck, tests and build.

## API (all under `/api/v1`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/auth/register` | none | Create account + workspace |
| POST | `/auth/login` | none | Log in |
| POST | `/auth/mfa/verify` | challenge token | Finish an MFA login |
| POST | `/auth/refresh` | cookie + CSRF | Get new tokens |
| POST | `/auth/logout` | cookie + CSRF | End this session |
| POST | `/auth/logout-all` | Bearer | End all sessions |
| GET | `/auth/sessions` | Bearer | List my devices |
| DELETE | `/auth/sessions/:sessionId` | Bearer | End one device |
| POST | `/auth/change-password` | Bearer + recent MFA | Change password, ends all sessions |
| POST | `/auth/mfa/setup` | Bearer + password | Start MFA setup |
| POST | `/auth/mfa/confirm` | Bearer | Turn MFA on |
| POST | `/auth/mfa/step-up` | Bearer | Prove MFA for sensitive actions |
| POST | `/auth/mfa/disable` | Bearer + password + code | Turn MFA off |
| GET / PATCH | `/users/me` | Bearer | My profile |
| GET | `/audit/me` | Bearer | My audit trail |

Outside `/api/v1`: `GET /health`, `GET /health/ready`, `GET /api/docs`.

### Try it

```bash
curl -i -c cookies.txt -H 'Content-Type: application/json' -d '{"name":"Showrov","email":"me@example.com","password":"a-long-password-here"}' http://localhost:5001/api/v1/auth/register
```

Copy `accessToken` from the response, then:

```bash
curl -H 'Authorization: Bearer PASTE_TOKEN_HERE' http://localhost:5001/api/v1/users/me
```

### Test every endpoint with Postman

`postman/Business_OS.postman_collection.json` has 46 requests covering every endpoint, with checks on each response. It saves tokens and generates MFA codes by itself.

**In the Postman app:**
1. Click **Import** and choose that file.
2. Make sure `npm run dev` is running. The collection's `baseUrl` variable defaults to `http://localhost:5001`.
3. Open the collection, click **Run**, and keep the requests in order.

**From the terminal:**

```bash
npx newman run postman/Business_OS.postman_collection.json
```

Each run registers a new `postman...@example.com` user in whichever database the API is using, and audit rows can't be deleted. Point the API at local Docker if you want to keep Neon clean. One request may wait up to 30 seconds, because each MFA code works only once. Running it more than about once a minute can hit the login rate limit (`429`).

## How Phase 1 was verified

- **72 integration tests pass** against real Postgres and Redis (`npm test`), and the suite passed on repeated runs. They include token reuse, simultaneous refreshes, code replay, forged tokens, CSRF, audit tampering and audit rollback.
- **All 46 Postman requests pass** (79 checks, run with Newman on a temporary local database).
- **The production build was run for real**: register, login, cookie flags and clean shutdown.
- **Telemetry was checked** against a stand-in collector: traces include HTTP, Express, Prisma and Redis spans, and no password appeared in the data sent.
- **Sentry was checked** against a stand-in server: an unexpected error is captured, and the client only sees `INTERNAL_ERROR`.
- **Redis outage was tested**: login still works and `/health/ready` returns 503.

Not verified:
- **GitHub Actions has not run**, because this folder is not a git repository yet. The same commands pass locally.
- **Real Sentry and Grafana accounts** have not been connected.
- **The Neon migration** has not been applied.

## What still needs you

1. **Choose the database** for `.env` (see [above](#which-database-does-env-use)).
2. **Run `git init`** and push to GitHub, so CI starts running.
3. **Answer the document's open questions** before later phases: hosting target, LLM provider, whether accrual accounting is needed at launch, and which bank and MFS credentials you hold.

## Differences from the architecture document

**Changed on purpose:**
| Document says | Built | Why |
|---|---|---|
| `repository`, `policies`, `events`, `index.ts`, `__tests__` in each module | Only router, controller, service, validation, interface | Your instruction. Services call Prisma directly, and tests live in `tests/` |
| `src/modules`, `src/infrastructure`, `src/shared` | `src/app/modules`, `src/lib`, `src/app/utils` | Follows the skeleton you had already started |
| ESLint rule blocking deep imports through `index.ts` | Not added | There is no `index.ts`. By convention, modules only import each other's services |
| `minio/minio` image | `cgr.dev/chainguard/minio` | The official image was refused on Docker Hub and Quay (Nov 2026) |
| Progressive login delay | Fixed lockout after 5 failures | Simpler, and it covers the same threat |

**Moved to a later phase:**
| Item | Phase | Why |
|---|---|---|
| Separate database role without UPDATE/DELETE, plus RLS | 2 | Arrives with the RLS work. Until then, triggers protect the audit table |
| Lockout and token-reuse emails, password reset | 6 | Needs email delivery. Until then these events go to the security log and audit |
| Nightly audit check | 6 | Needs BullMQ. Run `npm run audit:verify` by hand until then |
| `worker.ts` and the outbox | 3–6 | Nothing needs background work yet |
| Monthly partitions on `audit_logs` | Later | A scaling step, not needed at this size |
| Grafana, Loki and Tempo containers | 10 | The app already exports telemetry; only the receiving side is missing |

**Known gap:** the document has no MFA recovery codes. Since password reset also waits for Phase 6, a user who loses their authenticator today can only be recovered by editing the database. Consider adding recovery codes before relying on MFA in production.

## Before Phase 2

Phase 2 adds businesses, members, roles and permissions, the business context middleware and PostgreSQL RLS with tests proving cross-business reads fail. The `business_id` column on `audit_logs` is already in place for it.
