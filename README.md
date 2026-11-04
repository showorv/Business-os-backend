# Business OS Backend

Node.js, Express 5, TypeScript, PostgreSQL (Prisma 7) and Redis. This is a modular monolith built phase by phase from the *Business OS — System Architecture* document. Use this file to track what is done and how it works.

## Progress

| Phase | Name | Status |
|---|---|---|
| 1 | Foundation & auth | ✅ Done |
| 2 | Multi-business (businesses, members, RBAC, RLS) | ✅ Done |
| **3** | **Accounts & transactions** | ✅ **Done**, see [what still needs you](#what-still-needs-you) |
| 4 | Double-entry ledger | ⬜ Next |
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

- http://localhost:5001/health/ready should show `database`, `redis` and `storage` as `true`
- http://localhost:5001/api/docs is Swagger UI, where you can try every endpoint (not served in production)

### Which database does `.env` use?

Your `.env` points to **Neon**. Every new phase's migration must be applied there with `npm run db:deploy`. Redis and MinIO still run locally in Docker, so keep Docker running.

To use local Docker instead, set both `DATABASE_URL` and `DIRECT_DATABASE_URL` to `postgresql://business_os:business_os@localhost:5432/business_os`.

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
| `npm run db:provision` | Gives older businesses any starting data added since they were created. Safe to repeat |
| `npm run audit:verify` | Checks the audit hash chain; exits with 1 if it finds tampering |
| `npm run test:postman` | Runs the Postman collection against the API on port 5001 |
| `npm run postman:build` | Rebuilds the collection from `postman/generate-collection.mjs` |

## Folder structure

```
src/
├── server.ts              Starts the API and shuts it down cleanly
├── app.ts                 Express app: the middleware order lives here
├── instrument.ts          OpenTelemetry + Sentry, loaded before everything else
├── lib/                   prisma, redis, logger, storage (S3), rls (the business transaction helper)
├── scripts/               verify-audit, provision-businesses
├── types/express.d.ts     Adds req.auth, req.requestId, req.validated
└── app/
    ├── config/            env.config.ts (validated environment)
    ├── constants/         permissions, categoryTemplates
    ├── routes/index.ts    Module registry: a new module = one line here
    ├── docs/              Swagger spec: registry, openapi and one *.docs.ts per area
    ├── middlewares/       requestId, requestLogger, rateLimit, auth, businessContext, csrf, validate, errorHandler
    ├── utils/             errors, money, dates, pagination, idempotency, jwt, cookies, crypto, lockout...
    └── modules/
        ├── auth/          auth.router / controller / service / validation / interface
        ├── users/         same five files
        ├── audit/         same five files
        ├── businesses/    same five files
        ├── members/       same five files
        ├── invitations/   same five files
        ├── roles/         same five files
        ├── accounts/      same five files
        ├── categories/    same five files
        ├── documents/     same five files
        └── transactions/  same five files
prisma/
├── schema/                schema, workspace, auth, business, finance, document and audit models
└── migrations/
postman/                   Collection and the script that generates it
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

### How a business request travels

Everything under `/businesses/:businessId` adds these steps:

```
requireAuth              who are you?
 → requireMembership     are you in this business? No: 404, plus an audit row
 → requirePermission     does your role allow this? No: 403, plus an audit row
 → requireWritableBusiness   is the business ACTIVE? No: 409 (only on routes that change data)
 → requireRecentMfa      only on sensitive actions such as role changes
 → validate → controller → service
 → withBusinessScope     the database hides every other business
```

### How to add a new module (use this in every phase)

1. **Tables:** add models in `prisma/schema/`, then run `npx prisma migrate dev --create-only --name your_change`.
2. **Isolation:** for each business table, add `workspace_id` and `business_id`, and in the migration add the `GRANT`s and the RLS policy. Copy the pattern from the `invitations` table in `prisma/migrations/*_multi_business_rbac_rls/`.
3. **Code:** create the five files in `src/app/modules/<name>/`. `accounts` is the simplest one to copy.
4. **Business data:** in the service, run every query inside `withBusinessScope(business, (tx) => ...)`, and write audit rows with `auditService.recordForBusiness(tx, business, ...)` in that same transaction.
5. **Routes:** add one line in `src/app/routes/index.ts`. Use `Router({ mergeParams: true })` for routes under a business, and guard them with `businessRead(permission)` or `businessWrite(permission)`.
6. **Docs and tests:** add a `*.docs.ts` file, a line in `docs/openapi.ts`, a test file, and a folder in `postman/generate-collection.mjs`.

**Shared helpers to reuse:** `minorAmountField` for money, `dateField` for dates, `paginationQuery` with `pageArgs` and `toPage` for lists, and `withIdempotency` for create requests that clients may retry.

**New permission:** add it to `src/app/constants/permissions.ts` and to a new migration. A test fails if the two disagree.

**New error:** add a code to `src/app/utils/errors.ts`.

## What was built in Phase 3

**The goal:** record where money lives and what happened to it, as safe, validated **drafts**. Nothing touches the books yet: posting to the ledger is Phase 4.

### Step 1. Tables
| Table | Purpose |
|---|---|
| `financial_accounts` | Cash, bank, bKash, Nagad, other MFS and custom accounts |
| `categories` | Income and expense categories, with English and Bangla names |
| `transactions` | Income, expense, transfer, refund and adjustment drafts |
| `transaction_attachments` | Links transactions to documents |
| `documents` | Uploaded files; the bytes live in object storage |
| `business_sequences` | Counters for `TXN-2026-000123` numbers |
| `idempotency_keys` | Saved responses, so retries are safe |

All are protected by RLS, as in Phase 2. The restricted database role can't delete from them, except for attachment links.

### Step 2. Money
All money is a whole number of minor units (paisa for BDT), stored as `BIGINT`, and sent as a **string**: `"3000000"` means ৳30,000.00. A JSON number would silently lose precision on large amounts. Decimals and negatives are refused, and Bangla digits are accepted. See `src/app/utils/money.ts`.

### Step 3. New business setup
Creating a business now also creates a Cash account and starting categories for its type, in the same transaction. For businesses that already existed, run `npm run db:provision`.

### Step 4. Financial accounts
Accounts are never deleted, only deactivated. Only the last 4 digits of an account number are stored (`****9012`). The opening balance can't be edited after creation, because in Phase 4 it becomes a posted journal.

### Step 5. Transactions
Everything is created as a `DRAFT` with its own number. Drafts can be edited or voided, never deleted. These rules apply on both create and edit:

| Rule | Error code |
|---|---|
| Account must be active and in this business | `ACCOUNT_NOT_USABLE` |
| Category must be active and in this business | `CATEGORY_NOT_USABLE` |
| Income and refund use an income category; expense uses an expense category | `CATEGORY_TYPE_MISMATCH` |
| Income, expense and refund need a category | `CATEGORY_REQUIRED` |
| A transfer needs two different accounts | `TRANSFER_ACCOUNTS_INVALID` |
| A transfer has no category | `CATEGORY_NOT_ALLOWED` |
| Only a transfer can have a fee | `FEE_NOT_ALLOWED` |
| Currency must match the account, and both sides of a transfer | `CURRENCY_MISMATCH` |

The database also refuses a zero amount and an invalid transfer, in case the code ever misses one.

### Step 6. Idempotency (safe retries)
If a connection drops after you send a request, you can't tell whether it worked, and a retry could record the same expense twice. So the client sends a unique `Idempotency-Key` header:

- **Same key, same body:** returns the first response with `Idempotency-Replayed: true` and creates nothing.
- **Same key, different body:** `IDEMPOTENCY_KEY_REUSED`.
- **The first attempt failed:** the key isn't used up, so a retry runs normally.
- **Simultaneous retries:** only one transaction is created.

Keys belong to one user and last 24 hours. The key is saved in the same transaction as the data, so one can't exist without the other.

### Step 7. Duplicate detection
This is different from idempotency: it catches the same real-world payment entered twice. A transaction is flagged as `possibleDuplicate` when another one has the same account, type and amount within 2 days, and no conflicting reference. It's only a flag, because a repeat payment can be real, so the user decides with `POST .../dismiss-duplicate`.

### Step 8. Documents
Files go straight to object storage, so large uploads never pass through the API:

1. `POST /documents/uploads` returns a signed URL, valid for 15 minutes.
2. The client sends the file with `PUT` to that URL, using the same `Content-Type`.
3. `POST /documents/:id/complete` reads the stored file, checks its real size and type, and saves its SHA-256 hash.

A file whose bytes don't match what it claims is removed and marked `REJECTED`. PDF, PNG, JPEG and WebP are allowed, up to 25 MB. Downloads use a 5-minute link that always downloads rather than opening in the browser. Deleting a document hides it but keeps the file, and a document attached to a transaction can't be deleted.

## What was built in Phase 2

**The goal:** one person can run many businesses, invite people into each one, and nobody can see a business they don't belong to, even if the code has a bug.

### Step 1. Tables
| Table | Purpose |
|---|---|
| `businesses` | Name, type, currency, fiscal year, timezone, status, settings |
| `business_members` | Who belongs to which business, with which role |
| `invitations` | Pending invites; only a hash of the token is stored |
| `roles`, `permissions`, `role_permissions` | The role table from the document, stored as data |

### Step 2. Roles and permissions
There are five system roles: OWNER, ADMIN, ACCOUNTANT, MANAGER and VIEWER. Permissions are checked by route, for example `requirePermission(Permission.MEMBERS_MANAGE)`. `finance.read` is the one optional grant: an owner or admin can add it to a Manager or Viewer through `extraPermissions`.

### Step 3. Business context
`requireMembership` loads your role and permissions into `req.business` and caches them in Redis for up to 60 seconds. Any change to a member or to the business status clears that cache, so it applies on the very next request. If Redis is down, it reads from the database.

For a business you aren't in, the answer is always the same 404, whether the id is real, random or garbage, so ids can't be probed.

### Step 4. Row-Level Security (RLS)
This is the second lock, behind the app's own checks. PostgreSQL itself filters every row.

**Why the app switches database role:** the role the app connects with (`neondb_owner` on Neon, a superuser in Docker) **bypasses RLS completely**. So `src/lib/rls.ts` starts each business transaction by switching to `business_os_app`, a restricted role that cannot bypass RLS, and by setting which businesses are allowed:

```ts
const members = await withBusinessScope(business, (tx) => tx.businessMember.findMany());
// Even with no WHERE, PostgreSQL returns only this business's rows.
```

`business_os_app` has no `DELETE` on these tables, no `UPDATE` on `audit_logs`, and no access to `users`. All the settings last only for that transaction, so they are safe on pooled connections.

**When the normal connection is still used:** only where no business scope can exist yet: login, creating a business, accepting an invitation, and checking membership itself.

### Step 5. Business lifecycle
| Status | Behaviour | Can move to |
|---|---|---|
| `ACTIVE` | Normal | `INACTIVE`, `ARCHIVED` |
| `INACTIVE` | Read-only (`BUSINESS_NOT_ACTIVE`) | `ACTIVE`, `ARCHIVED` |
| `ARCHIVED` | Read-only, hidden from the list unless `?includeArchived=true` | `ACTIVE` |

Businesses are never hard-deleted.

### Step 6. Invitations
1. An owner or admin calls `POST /businesses/:id/invitations` and gets a token, once. It lasts 7 days. **There is no email yet, so share it by hand until Phase 6.**
2. The invited person logs in and calls `POST /invitations/accept` with the token.

Their account email must match the invitation, so a stolen token is useless on another account. Inviting the same email again replaces the old invitation. Nobody can be invited as OWNER: an owner promotes an existing member instead.

### Step 7. Member rules
- A business always keeps at least one owner (`LAST_OWNER`), even if two owners demote each other at the same moment.
- Only an owner can change an owner or create one.
- Changing a role or removing a member needs recent MFA if the person doing it has MFA on.
- Removing a member keeps the row, so audit history still makes sense.

### Step 8. Business audit
`GET /businesses/:id/audit` shows one business's history, with `audit.read`. Denied access and denied permissions are recorded too. The hash chain spans a whole workspace but RLS hides other businesses' rows, so the database function `audit_chain_head` returns only the latest hash, keeping the chain unbroken.

### Step 9. Settings
`settings` is validated by the Zod schema in `businesses.validation.ts` and has a `version`. A `PATCH` merges only the keys you send. Amounts are integer strings in minor units, and Bangla digits are accepted.

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
| GET | `/roles` | Bearer | System roles and permissions |
| POST | `/businesses` | Bearer | Create a business (you become owner) |
| GET | `/businesses` | Bearer | List my businesses |
| GET | `/businesses/:businessId` | member | Details, my role and permissions |
| PATCH | `/businesses/:businessId` | `business.manage` | Edit details and settings |
| POST | `/businesses/:businessId/status` | `business.manage` | Deactivate, archive, reactivate |
| GET | `/businesses/:businessId/members` | member | List members |
| PATCH | `/businesses/:businessId/members/:memberId` | `members.manage` + recent MFA | Change role or grants |
| DELETE | `/businesses/:businessId/members/:memberId` | `members.manage` + recent MFA | Remove a member |
| POST | `/businesses/:businessId/invitations` | `members.manage` | Invite (returns the token once) |
| GET | `/businesses/:businessId/invitations` | `members.manage` | List pending invites |
| DELETE | `/businesses/:businessId/invitations/:invitationId` | `members.manage` | Revoke an invite |
| POST | `/invitations/accept` | Bearer | Join with a token |
| GET | `/businesses/:businessId/audit` | `audit.read` | One business's audit trail |
| POST / GET | `/businesses/:businessId/accounts` | `finance.write` / `finance.read` | Create or list accounts |
| GET / PATCH | `/businesses/:businessId/accounts/:accountId` | `finance.read` / `finance.write` | Read or edit an account |
| POST / GET | `/businesses/:businessId/categories` | `finance.write` / `finance.read` | Create or list categories |
| PATCH | `/businesses/:businessId/categories/:categoryId` | `finance.write` | Edit a category |
| POST / GET | `/businesses/:businessId/transactions` | `finance.write` / `finance.read` | Create a draft or list with filters |
| GET / PATCH | `/businesses/:businessId/transactions/:transactionId` | `finance.read` / `finance.write` | Read or edit a draft |
| POST | `.../transactions/:transactionId/void` | `finance.write` | Void a draft |
| POST | `.../transactions/:transactionId/dismiss-duplicate` | `finance.write` | Clear a duplicate flag |
| POST | `.../transactions/:transactionId/attachments` | `finance.write` | Attach a document |
| DELETE | `.../transactions/:transactionId/attachments/:documentId` | `finance.write` | Remove an attachment |
| POST | `/businesses/:businessId/documents/uploads` | `documents.write` | Get a signed upload URL |
| POST | `/businesses/:businessId/documents/:documentId/complete` | `documents.write` | Check the file and mark it ready |
| GET | `/businesses/:businessId/documents` | `documents.read` | List documents |
| GET | `/businesses/:businessId/documents/:documentId/download` | `documents.read` | Get a download link |
| DELETE | `/businesses/:businessId/documents/:documentId` | `documents.write` | Soft delete |

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

`postman/Business_OS.postman_collection.json` has 123 requests covering every endpoint, with checks on each response. It saves tokens and generates MFA codes by itself.

**In the Postman app:**
1. Click **Import** and choose that file.
2. Make sure `npm run dev` is running. The collection's `baseUrl` variable defaults to `http://localhost:5001`.
3. Open the collection, click **Run**, and keep the requests in order.

**From the terminal:**

```bash
npm run test:postman
```

Each run registers a new `postman...@example.com` user in whichever database the API is using, and audit rows can't be deleted. Point the API at local Docker if you want to keep Neon clean. One request may wait up to 30 seconds, because each MFA code works only once. A run registers 7 times and sign-ups are limited to 10 per 10 minutes, so a second run soon after gets `429`. On local Docker Redis you can clear the limits with:

```bash
docker exec business_os_redis redis-cli flushall
```

## How it was verified

**Phase 3:**
- **194 integration tests pass** (67 of them new), with real file uploads to MinIO. They cover precision on large amounts, simultaneous retries, simultaneous numbering, every transaction rule, fake file types and ids from other businesses.
- **The suite also passes as a role like Neon's owner**, on a temporary PostgreSQL 17 database. With RLS switched off on `financial_accounts`, the tests fail, as they should.
- **All 123 Postman requests pass** on the built server, run with Newman on a temporary local database. They reach all 50 documented operations.
- **Timed with Neon-like delay** (260ms per round trip, simulated locally): creating a transaction takes about 4.5 seconds, a business about 3.8 and a list about 1.6.

**Phase 2:**
- **127 integration tests pass** (55 of them new), covering cross-business access, role permissions, invitations, owner protections and lifecycle.
- **RLS was tested with a role like Neon's owner:** the whole suite also passes on a temporary PostgreSQL 17 database, connected as a non-superuser with `BYPASSRLS` and `CREATEROLE`.
- **The RLS tests were proven to work:** with RLS switched off on `businesses`, 3 of them fail.
- **All 86 Postman requests pass**, run with Newman on a temporary local database.

**Phase 1:**
- **Hard cases are tested:** token reuse, simultaneous refreshes, code replay, forged tokens, CSRF, audit tampering and audit rollback.
- **The production build was run for real**: register, login, cookie flags and clean shutdown.
- **Telemetry and Sentry were checked** against stand-in servers. No password appeared in the data sent.
- **A Redis outage was tested**: login still works and `/health/ready` returns 503.

**Not verified:**
- **The Phase 3 migration has not been run on Neon** (PostgreSQL 18). It was tested on PostgreSQL 17. Phase 2's migration did work on Neon.
- **Cloudflare R2 or S3** have not been tried. Uploads were tested on MinIO only.
- **GitHub Actions results** have not been checked.
- **Real Sentry and Grafana accounts** have not been connected.

## What still needs you

1. **Update Neon:** run `npm run db:deploy`, then `npm run db:provision` to give your existing business its Cash account and categories.
2. **Decide on accrual accounting before Phase 4:** is it needed at launch (invoices, AR/AP), or is cash-basis enough? This is one of the document's open questions, and it shapes the posting rules.
3. **Answer the document's other open questions** before later phases: hosting target, LLM provider, and which bank and MFS credentials you hold.

## Differences from the architecture document

**Changed on purpose:**
| Document says | Built | Why |
|---|---|---|
| `repository`, `policies`, `events`, `index.ts`, `__tests__` in each module | Only router, controller, service, validation, interface | Your instruction. Services call Prisma directly, and tests live in `tests/` |
| `src/modules`, `src/infrastructure`, `src/shared` | `src/app/modules`, `src/lib`, `src/app/utils` | Follows the skeleton you had already started |
| A separate login for the app's database role | One login that switches to `business_os_app` inside business transactions | Login and sign-up need access RLS would block, and this needs no second password |
| Accountant "read own" audit | Uses `GET /audit/me` | Every user already has it, so no extra permission is needed |
| Opening balance posts a journal; account row linked to the ledger | `current_balance_minor` starts at the opening balance | The ledger is Phase 4, which replaces this with a real journal |
| `X-Business-Id` header mentioned in one diagram | Business id in the URL | The document's other sections use the URL, and it keeps routes explicit |
| ESLint rule blocking deep imports through `index.ts` | Not added | There is no `index.ts`. By convention, modules only import each other's services |
| `minio/minio` image | `cgr.dev/chainguard/minio` | The official image was refused on Docker Hub and Quay (Nov 2026) |
| Progressive login delay | Fixed lockout after 5 failures | Simpler, and it covers the same threat |

**Moved to a later phase:**
| Item | Phase | Why |
|---|---|---|
| Invitation emails | 6 | Needs email delivery. The token is returned to the inviter for now |
| Business setup: chart of accounts and fiscal periods | 4 | Added in `businessesService.provision` |
| Approval flow, posting, reversals and the fiscal period check | 4 | Drafts are all that exist until the ledger does |
| Linking accounts and categories to ledger accounts | 4 | The chart of accounts doesn't exist yet |
| Malware scanning and OCR | 8 | `scan_status` is `NOT_SCANNED` until the ingestion pipeline exists |
| Cleaning up abandoned uploads and expired idempotency keys | 6 | Needs background jobs. They do no harm until then |
| Enforcing `enabledModules` per business | SaaS | The setting is stored, but nothing reads it yet |
| Blocking a base currency change once journals are posted | 4 | No journals exist yet. Until then the change is allowed; a comment marks the spot |
| Counterparties (customers and suppliers) | Not in any phase's list | The ER diagram has the table, but no phase includes the module. `counterparty_id` is added when it's built |
| Custom fields | Not in any phase's list | Section 8.4 describes them, but no phase includes them |
| Approval threshold being enforced | 4 | The setting is stored now; transactions arrive later |
| Consolidated "all businesses" endpoints | 5 | Listed under Analytics in the roadmap |
| Plan limits and custom roles | SaaS | The tables already allow custom roles; no endpoint yet |
| Lockout and token-reuse emails, password reset | 6 | Needs email delivery. Until then these events go to the security log and audit |
| Nightly audit check | 6 | Needs BullMQ. Run `npm run audit:verify` by hand until then |
| `worker.ts` and the outbox | 3–6 | Nothing needs background work yet |
| Monthly partitions on `audit_logs` | Later | A scaling step, not needed at this size |
| Grafana, Loki and Tempo containers | 10 | The app already exports telemetry; only the receiving side is missing |

**Known gap:** an upload URL stays valid for its full 15 minutes, even after the file is marked `READY`. Someone holding the link could replace the file with another of the same size and type, leaving the saved hash out of date. Phase 8's scanning step is the natural place to re-check the hash.

**Known gap:** the document has no MFA recovery codes. Since password reset also waits for Phase 6, a user who loses their authenticator today can only be recovered by editing the database. Consider adding recovery codes before relying on MFA in production.

## Before Phase 4

Phase 4 is the critical gate: chart of accounts templates, journals, the posting engine, fiscal periods, reversals, period close, and the trial balance, P&L, balance sheet and cash flow. Drafts from Phase 3 become `POSTED` there, and analytics, budgets, integrations and AI all wait until its test suite is green.
