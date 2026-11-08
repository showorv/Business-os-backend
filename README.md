# Business OS Backend

Node.js, Express 5, TypeScript, PostgreSQL (Prisma 7) and Redis. This is a modular monolith built phase by phase from the *Business OS — System Architecture* document. Use this file to track what is done and how it works.

## Progress

| Phase | Name | Status |
|---|---|---|
| 1 | Foundation & auth | ✅ Done |
| 2 | Multi-business (businesses, members, RBAC, RLS) | ✅ Done |
| 3 | Accounts & transactions | ✅ Done |
| 4 | Double-entry ledger | ✅ Done |
| 5 | Analytics & reports | ✅ Done |
| 6 | Tasks & reminders (email, notifications) | ✅ Done |
| 7 | Integrations (statement import, matching) | ✅ Done |
| **8** | **AI & RAG** | ✅ **Done**, see [what still needs you](#what-still-needs-you) |
| 9 | Frontend | ✅ Done (in `Business_os_frontend`) |
| 10 | Hardening & launch | ⬜ |
| **11** | **SaaS: plans, payments, admin panel, invoices, VAT, saved items, public pages** | ✅ Done |

## Run it

You need Docker Desktop running and Node. This was built and tested on Node 26.

**Step 1. Install packages**

```bash
npm install
```

**Step 2. Start Postgres, Redis, MinIO and Mailpit**

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

**Step 7. Start the worker, in a second terminal**

```bash
npm run worker
```

The worker makes report exports, checks budgets and goals, fires reminders, sends email and push, runs recurring transactions, imports statements, syncs connections and does the nightly checks. The API runs without it, but all of that waits until it starts.

**Step 8. Check it**

- http://localhost:5001/health/ready should show `database`, `redis` and `storage` as `true`
- http://localhost:5001/api/docs is Swagger UI, where you can try every endpoint (not served in production)
- http://localhost:8025 is Mailpit, which catches every email sent in development. Add `SMTP_URL=smtp://localhost:1025` to `.env` to use it

### Which database does `.env` use?

Your `.env` points to **Neon**. Every new phase's migration must be applied there with `npm run db:deploy`. Redis and MinIO still run locally in Docker, so keep Docker running.

To use local Docker instead, set both `DATABASE_URL` and `DIRECT_DATABASE_URL` to `postgresql://business_os:business_os@localhost:5432/business_os`.

Tests never touch Neon. They always use the local `business_os_test` database, and they stop with an error if pointed anywhere else.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Starts the API and restarts on file changes |
| `npm run worker` | Starts the background worker and restarts on file changes |
| `npm run build` then `npm start` and `npm run start:worker` | Production build, API and worker |
| `npm test` | Runs all tests (needs Docker running) |
| `npm run lint` / `npm run typecheck` | Code checks |
| `npm run db:migrate` | Creates a new migration after you change `prisma/schema/*` |
| `npm run db:deploy` | Applies existing migrations |
| `npm run db:status` | Shows which migrations are applied |
| `npm run db:provision` | Gives older businesses any starting data added since they were created. Safe to repeat |
| `npm run audit:verify` | Checks the audit hash chain; exits with 1 if it finds tampering |
| `npm run ledger:verify` | Checks every journal balances and every cached balance matches the ledger; exits with 1 if not. The worker also runs this nightly |
| `npm run test:models` | Tests the real embedding model and OCR. Slow, so it isn't in `npm test` |
| `npm run ai:eval` | Scores the real AI against the evaluation set. Needs `AI_API_KEY`, and uses your daily quota |
| `npm run test:postman` | Runs the Postman collection against the API on port 5001 |
| `npm run postman:build` | Rebuilds the collection from `postman/generate-collection.mjs` |
| `npm run postman:demo` | Rebuilds the one-month demo from `postman/generate-demo-month.mjs` |

## Folder structure

```
src/
├── server.ts              Starts the API and shuts it down cleanly
├── worker.ts              Starts the background worker: same code, run as a second process
├── app.ts                 Express app: the middleware order lives here
├── instrument.ts          OpenTelemetry + Sentry, loaded before everything else
├── lib/                   prisma, redis, logger, storage (S3), queues (BullMQ), rls (the business transaction helper), mailer, webPush, realtime
├── scripts/               verify-audit, verify-ledger, provision-businesses
├── types/express.d.ts     Adds req.auth, req.requestId, req.validated
└── app/
    ├── config/            env.config.ts (validated environment)
    ├── constants/         permissions, categoryTemplates, chartOfAccounts
    ├── admin/             queueBoard (the Bull Board screen)
    ├── jobs/              outboxRelay, deliveryRelay, processEvent, eventTypes, domainEvents, reminderJobs, overdueScan, integrationSync, maintenance
    ├── exports/           reportTable, renderPdf, renderXlsx, renderCsv
    ├── notifications/     templates (email and push wording, English and Bangla)
    ├── integrations/      adapter (the contract), registry, sandbox.adapter, statementFile (reads CSV and Excel)
    ├── ai/                provider, orchestrator, tools, guard, search, ingestion, extractText, chunkText
    ├── routes/index.ts    Module registry: a new module = one line here
    ├── docs/              Swagger spec: registry, openapi and one *.docs.ts per area
    ├── middlewares/       requestId, requestLogger, rateLimit, auth, businessContext, csrf, validate, errorHandler
    ├── utils/             errors, money, dates, pagination, idempotency, outbox, postingRules, sequences, jwt...
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
        ├── transactions/  same five files
        ├── ledger-accounts/  same five files (chart of accounts)
        ├── fiscal-periods/   same five files
        ├── journals/         same five files (the posting engine)
        ├── reports/          same five files
        ├── reconciliations/  same five files
        ├── analytics/        same five files
        ├── budgets/          same five files
        ├── goals/            same five files
        ├── exchange-rates/   same five files
        ├── consolidated/     same five files
        ├── report-exports/   same five files
        ├── tasks/            same five files
        ├── reminders/        same five files
        ├── recurring-schedules/  same five files
        ├── notifications/    same five files
        ├── integrations/     same five files (connections, sync history, webhooks)
        ├── statement-templates/  same five files
        ├── statement-imports/    same five files
        ├── statement-lines/      same five files (the matcher and review inbox)
        ├── statement-rules/      same five files
        └── ai/               same five files (chat, conversations, proposals)
prisma/
├── schema/                schema, workspace, auth, business, finance, ledger, analytics, tasks, notifications, document and audit models
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

**Anything that changes money:** never write to `journal_entries` directly. Call `journalsService.post(tx, business, ...)` inside your transaction. **A new transaction type** adds one rule in `src/app/utils/postingRules.ts`.

**Something slow, external or retryable:** don't do it in the request. In the same transaction call `publishEvent(tx, actor, EventType.X, payload)`, add the event's queue in `src/app/jobs/eventTypes.ts`, and handle it in `src/app/jobs/processEvent.ts`. Handlers may run twice, so they must be safe to repeat.

**New permission:** add it to `src/app/constants/permissions.ts` and to a new migration. A test fails if the two disagree.

**New error:** add a code to `src/app/utils/errors.ts`.

## What was built in Phase 11 (SaaS)

**The goal:** turn Business OS into a product other businesses pay for. Free gives one business without the AI; Pro gives several businesses, a bigger team, more storage and the AI, paid monthly or yearly. You (the platform admin) can give Pro free to anyone and change prices and limits from an admin panel.

| Step | What it covers | Status |
|---|---|---|
| 11.1 | Plans and limits: trial, enforcement, Plan page, upgrade prompts | ✅ Done |
| 11.2 | Payments through a demo gateway (success, fail, cancel), receipts, reminders, grace; SSLCommerz and bKash plug in later | ✅ Done |
| 11.3 | Platform admin panel: workspaces and users, change plans, grant Pro until a date, prices and limits, coupons, AI cap, suspend, revenue, announcements | ✅ Done |
| 11.4 | Customers and suppliers | ✅ Done |
| 11.5 | Invoices, bills, baki and aging, PDF and email, posting to the books | ✅ Done |
| 11.6 | VAT rates on lines and a monthly VAT summary (help with Mushak, not a full NBR filing) | ✅ Done |
| 11.7 | Saved items for invoice and bill lines (no stock counting; see below why) | ✅ Done |
| 11.8 | Launch basics: public home and pricing pages, terms and privacy, data export | ✅ Done |

### Step 11.1: Plans and limits

**Who has a plan.** The plan belongs to a *workspace*, and each person who signs up owns one. Businesses live in a workspace, so a plan covers all the businesses its owner made. Someone invited into another person's business uses that business's plan, not their own.

**The two plans** (stored in the new `plans` table, so the admin panel can change them later without code):

| | Free | Pro |
|---|---|---|
| Price | ৳0 | ৳599 a month or ৳5,990 a year |
| Businesses | 1 | 5 |
| People (across all its businesses) | 3 | 15 |
| Document storage | 500 MB | 10 GB |
| AI assistant | No | Yes, up to 100,000 tokens a day |

**What happens over time.**
- **Sign up:** 14 days of Pro free (a trial). No card needed.
- **Trial ends:** you move to Free. Nothing is deleted.
- **A paid plan ends:** it keeps working for 7 more days (grace), then moves to Free.
- **Given free by the admin:** Pro until the date the admin chose, or with no end date.

**What the limits do.**
- **A new business, a restored business, an invitation or an upload** that would go over the plan is refused with `403 PLAN_LIMIT`, and the error says which limit and the number (`{limit: "businesses", max: 1, plan: "free"}`).
- **More businesses than the plan allows** (after a trial or plan ends): the oldest ones keep working; the newer ones can still be read, but anything that changes them is refused with `PLAN_BUSINESS_LOCKED`. Archiving is still allowed, and archived businesses don't count. Upgrading unlocks everything.
- **People** are counted once each, by email, across all the workspace's businesses, including invitations not yet accepted.
- **The AI** only answers about businesses whose plan includes it (`PLAN_FEATURE_REQUIRED` otherwise). The daily token limit comes from the plan, and never goes above `AI_DAILY_TOKEN_LIMIT` in `.env`.

**New endpoints.**
- `GET /billing/plans`: the public plans and prices (no sign-in needed, for the pricing page).
- `GET /billing/me`: your plan, its state (`free`, `trial`, `active`, `grace`, `expired`, `granted`), its end date, whether you own the account, and what you use (businesses, people, storage, AI today).
- `GET /businesses/:id` now includes `plan: {key, name, state, aiEnabled, locked}`.
- `GET /ai/status` now includes `planAllowsAi`.

**Database change** (migration `20261107120000_plans_subscriptions`):
- new tables `plans` and `workspace_subscriptions`
- `workspaces.owner_user_id`, filled in from each person's own workspace
- the Free and Pro plans, in English and Bangla
- **every workspace that already exists gets Pro free with no end date** ("Existing account before plans"), so nobody who used the app before loses anything. You can change that from the admin panel in 11.3.

**How it was checked.** 8 new tests (`tests/billing.test.ts`): public plans; the trial on sign-up; an invited person sees their own plan; a trial ending (third business refused, the newer business locked, archive allowed, restore refused, a grant unlocks it); the 7-day grace; people counted once; storage; AI refused on Free. All 744 tests pass.

### Step 11.2: Paying for a plan (demo gateway)

You don't have an SSLCommerz or bKash merchant account yet, so payments go through a **demo gateway**: a pretend payment page in the web app where you choose what the gateway answers (paid, failed or cancelled). **No money moves.** Everything else is real: the payment record, the receipt, the plan change, the emails. When a merchant account is ready, only the gateway adapter (`src/lib/payments.ts`) and one callback route are added.

**How one payment goes.**
1. The account's owner presses *Upgrade* on the Plan page. `POST /billing/checkout {planKey, billingCycle}` saves a payment as `PENDING`, with the price **taken from the plan on the server** (whatever the browser sends is ignored), and returns where to pay.
2. The person pays on the gateway's page (for now, the demo page). The checkout lasts 30 minutes.
3. The gateway's answer settles the payment, once. If it's paid:
   - the plan runs for one more month or year;
   - days already covered on the same plan are kept: paying during the trial starts the paid year when the trial ends, and paying early adds the year after the current one;
   - after a plan has ended, the new period starts now, and any read-only businesses work again;
   - the payment gets a receipt number (`BOS-2026-000001`) and the period it paid for;
   - the owner gets a receipt email and an in-app notification.
4. Failed or cancelled: the plan stays as it was, and the attempt shows in the payment history.

Receiving the same answer twice changes nothing (gateways do resend). A different answer for a finished payment is refused (`PAYMENT_NOT_PENDING`). A checkout older than 30 minutes can't be paid (`PAYMENT_EXPIRED`).

**Reminder emails** (a new daily job at 10:00 Bangladesh time, `billing.plan-reminders`):
- a trial ending: 3 days and 1 day before;
- a paid plan, or Pro given free until a date, ending: 7 days and 1 day before;
- a paid plan in its 7 grace days, and any plan that has moved to Free.

Each one goes once per end date, so renewing brings fresh reminders and nothing is sent twice. They always send, like password emails, because they're about the account.

**New endpoints.**
- `POST /billing/checkout`: start paying (owner only).
- `GET /billing/payments`: the payment history (unfinished checkouts left out).
- `GET /billing/payments/:id`: one payment, with what the receipt needs.
- `POST /billing/payments/:id/demo`: the demo page's answer. It only works while the demo gateway is on.

**Safety.** The demo gateway would give Pro away free, so with `NODE_ENV=production` it is **switched off** unless `PAYMENT_DEMO_IN_PRODUCTION=true`. Only the account's owner can pay (`BILLING_OWNER_ONLY`). Someone else's payment answers `404`. Every checkout, payment, failure and cancellation is written to the audit log.

**Database change** (migration `20261108090000_payments`): a new `payments` table and a receipt number counter. Run `npm run db:deploy` on Neon.

**New settings in `.env`** (see `.env.example`): `PAYMENT_GATEWAY=demo` and `PAYMENT_DEMO_IN_PRODUCTION=false`. Neither is a secret.

**How it was checked.** 7 new tests (`tests/payments.test.ts`):
- paying during the trial (the year starts after it, the receipt, the email; a repeat answer changes nothing, and a different one is refused);
- a failed and a cancelled payment, both in the history;
- paying after a lapse unlocks businesses;
- what can't be bought, other people's payments, a lifetime gift, and someone who isn't the owner;
- an expired checkout;
- reminders sent once, then again at 1 day;
- month arithmetic (31 January plus one month is the end of February).

All 751 tests pass.

### Step 11.3: Platform admin panel

The person who runs Business OS (you) now has an admin panel at `/admin` in the web app, backed by `/api/v1/admin/*`.

**Who can open it.** Only someone marked as a platform admin **and** with two-step sign-in turned on. Nobody is an admin by default. On a server, run `npm run admin:grant -- you@example.com` (and `npm run admin:revoke -- you@example.com` to take it away). Without two-step sign-in the API answers `PLATFORM_ADMIN_MFA_REQUIRED`; anyone else gets `PLATFORM_ADMIN_ONLY`.

**What an admin can do.**

| Area | What it does |
|---|---|
| Overview | Monthly income, money received this month and in each of the last 12 months, accounts by plan state, people |
| Accounts | Search and filter every workspace. Open one to see its plan, usage, businesses, payments and what admins changed |
| Change plan | Give a plan free until a date or for good (with a private note), set a trial, or move it to Free. The owner gets an email |
| Suspend | Nobody can open a suspended account's businesses (`WORKSPACE_SUSPENDED`), and they drop out of combined views. Nothing is deleted. Lifting it puts everything back |
| People | Everyone with an account, with two-step status and last sign-in |
| Plans | Change prices, limits, AI and the daily AI allowance, or add a plan. A change applies to every account on the plan at once. Free always stays at ৳0 |
| Coupons | A percentage or an amount off, for some plans or all, with a use limit and a last day. A 100% coupon gives the plan without a payment page |
| Payments | Every payment, with filters |
| Settings | Trial length and plan, grace days, the AI switch (`AI_PAUSED` for everyone while off), whether anyone can sign up (`SIGNUPS_CLOSED`, except people with an invitation), and an announcement shown at the top of every page |
| Admin history | Every change made from the panel, kept in the audit log as `platform.*` |

**For customers.** A "Have a coupon?" box on the Plan page checks a code with `POST /billing/price` and shows the new price before paying; `COUPON_INVALID` says why a code can't be used (not found, switched off, expired, used up, or for another plan). The public `GET /platform/announcement` gives the message for the top of the page.

**Database.** Migration `20261108120000_platform_admin`: `users.is_platform_admin`; `workspaces.suspended_at` and `suspended_reason`; coupon columns on payments (list price, discount, code); new `coupons` and `platform_settings` tables. Settings are cached for 10 seconds, so a change shows everywhere within that time.

**How it was checked.** 7 new tests (`tests/platform-admin.test.ts`): only admins with two-step get in; giving Pro free, a trial and Free; suspending and lifting; plan edits; coupons from creation to a 100% coupon settling at once; settings (AI pause, closed sign-ups, the announcement); and the history. All 758 tests pass.

### Step 11.4: Customers and suppliers

Each business keeps a list of the people and shops it sells to and buys from, under `/businesses/:businessId/contacts`.

- **A contact** is a customer, a supplier, or both, with a name and optionally a shop or company, phone, email, address, BIN/TIN (for VAT later) and notes. Contacts are never deleted: archiving hides them from lists and pickers, and old transactions keep the name.
- **The list** is sorted by name, can be searched by name, company, phone or email, and filtered to customers or suppliers (a "both" contact shows in each).
- **Totals for each contact:** money received (income) and money paid (expenses and refunds), how many transactions, and the last date. Only posted transactions count, one row per currency.
- **Transactions can name a contact:** `contactId` on create and on a draft edit, a `contactId` filter on the list, and `POST /transactions/:id/contact` to set or clear it later, even after posting (the books don't change). A voided transaction can't be changed. An archived contact, or one from another business, is refused with `CONTACT_NOT_USABLE`.
- **Who can see them:** the same rules as money: `finance.read` to see, `finance.write` to change. A viewer without money access can't see contacts either.
- **Audit:** `contact.created`, `contact.updated`, `contact.archived`, `transaction.contact_set`.

What a contact still owes, or what you owe them (baki), comes from invoices and bills (11.5, below).

**Database.** Migration `20261109090000_contacts`: the `contacts` table with row-level security, and `transactions.contact_id`.

**Also changed.** The limit on requests per minute from one address is now a setting, `RATE_LIMIT_PER_MINUTE` (default 300). Many phones can share one mobile-network address, so raise it if real users see "Too many requests". The browser tests' backend uses 3000, because every test there comes from the same address.

**How it was checked.** 5 new tests (`tests/contacts.test.ts`): adding, listing by kind and search, changing and archiving with audit entries; a bad email and an empty change refused; totals (income in, expenses and refunds out, drafts and other contacts left out) and the transaction filter; tagging a posted transaction and refusing archived or other businesses' contacts; and the money permissions. All 763 tests pass.

### Step 11.5: Invoices, bills and dues (baki)

An **invoice** is what a customer owes the business for a sale on credit. A **bill** is what the business owes a supplier. Both live in one table and work the same way, under `/businesses/:businessId/invoices` with `kind` `SALE` or `BILL`.

**The life of an invoice**
```
DRAFT ── issue ──> ISSUED ── part payment ──> PARTIALLY_PAID ── rest ──> PAID
  │                  │                                                    │
delete            void (only with no payments)        undo a payment moves it back
```
- **Draft:** a contact, a date, a due date, an optional reference (a customer's order number, or the supplier's own bill number), notes, and up to 100 lines. Each line has a description, a quantity (up to 3 decimals, so 2.5 kg works), a unit price and a category. An invoice uses income categories, a bill expense categories. Drafts can be changed or deleted; nothing is in the books yet.
- **Issue:** gives the next number (`INV-2026-000001`, `BILL-2026-000001`, no gaps, each business counts on its own) and posts one journal entry on the invoice date:
  - Invoice: **debit Accounts Receivable (1200)**, credit each line's revenue account.
  - Bill: debit each line's expense account, **credit Accounts Payable (2000)**.
  So the sale shows in the profit and loss when it is made, not when the money arrives.
- **Payment:** money in (or out) through any of the business's accounts, up to what is still due, on its own date. It posts: cash or bank debited, receivables credited (the other way round for a bill). The account's balance moves too. A payment entered by mistake is **undone** with a reversing entry; the record stays, marked undone.
- **Void:** an issued invoice with no payments can be voided with a reason; its entry is reversed. Undo the payments first if it has any.
- Two payments at the same moment can't both pass the "how much is due" check: the invoice row is locked while one is saved.

**Dues (baki).** `GET /invoices/aging?kind=SALE` (or `BILL`) adds up what is still owed on open invoices, per contact, by how late it is: not due yet, 1–30, 31–60, 61–90 and over 90 days past the due date. It can be worked out as of an earlier day (`asOf`), and for one contact (`contactId`). Biggest balances come first.

**PDF and email.** `GET /invoices/:id/pdf` gives the invoice or bill as an A4 PDF, in English or Bangla (`locale=bn-BD` prints Bangla digits), made by the same browser-based renderer as report PDFs, so Bangla letters join correctly. A draft is stamped DRAFT and a void one VOID. `POST /invoices/:id/email` sends an issued invoice to the customer's email (or another address), with the PDF attached and an optional message. It needs `SMTP_URL`; without it the answer is `EMAIL_NOT_CONFIGURED`.

**A contact's totals** now include payments on their invoices and bills, so "received from them" and "paid to them" match what really moved.

**Errors:** `INVOICE_NOT_DRAFT`, `INVOICE_NOT_OPEN`, `INVOICE_TOTAL_ZERO`, `INVOICE_HAS_PAYMENTS`, `PAYMENT_EXCEEDS_DUE` (with `dueMinor`), `PAYMENT_ALREADY_VOID`, `CONTACT_KIND_MISMATCH` (an invoice needs a customer, a bill a supplier; "both" fits either), `CATEGORY_TYPE_MISMATCH` (with the line number), `INVOICE_NOT_SENDABLE`, `EMAIL_NOT_CONFIGURED`.

**Permissions and audit:** `finance.read` to see, `finance.write` to change. Audit entries: `invoice.created`, `invoice.updated`, `invoice.deleted`, `invoice.issued`, `invoice.payment_recorded`, `invoice.payment_voided`, `invoice.voided`, `invoice.emailed`.

**Not yet:** invoices in another currency (only the business's own currency for now), and matching invoice payments to bank statement lines.

**Database.** Migration `20261110090000_invoices_bills`: the `invoices`, `invoice_lines` and `invoice_payments` tables with row-level security, plus checks in the database itself (paid never above the total, due date not before the date, an issued invoice always has a number). Run `npm run db:deploy` on Neon.

**How it was checked.** 10 new tests (`tests/invoices.test.ts`): line amounts and rounding, and that the posting rules always balance; drafting, changing and issuing with numbers in order, and the books moving only on issue; part and full payments, paying too much refused, undoing a payment and voiding; a bill paid from the bank; the wrong contact kind or category side, a zero invoice and bad dates refused; the list filters and another business kept out; baki by age, per contact and as of an earlier day; the PDF and the email with its attachment; and the money permissions. All 773 tests pass.

### Step 11.6: VAT on invoices and bills, and the month's VAT

Bangladesh VAT is usually 15%, with lower rates (10%, 7.5%, 5%) and 0% for some goods. This step helps a business keep its VAT right and fill in its monthly return (Mushak 9.1). It does not file anything with NBR.

**Is the business VAT-registered?** Two new business settings: `vatRegistered` (has a BIN; off by default) and `defaultVatRateBp`, the rate new invoice lines start with (1500 = 15%, the default). Rates are kept in basis points, so 7.5% is 750.

**VAT on a line.** Every invoice and bill line can have `vatRateBp` (0 to 100%, 0 if left out). The line's VAT is its amount × rate, rounded to the nearest paisa (half up). The invoice keeps a **subtotal**, the **VAT** and the **total** (subtotal + VAT; the database checks they add up).

**What it does to the books when issued**
- **Invoice with VAT:** debit Accounts Receivable for the full total, credit the sales accounts with the subtotal, and credit **VAT Payable (2200)** with the VAT. The VAT is money owed to the government, not income.
- **Bill, business registered:** the VAT goes to **VAT Input (1400)**, an asset, because it can be claimed back against output VAT. The expense is only the price without VAT.
- **Bill, business not registered:** the VAT can't be claimed, so it is added to the expense on each line. The bill is marked `vatRecoverable: false`.
- **An invoice with VAT from a business that isn't registered** is refused (`VAT_NOT_REGISTERED`), including when a draft made earlier is issued after the setting was turned off.
- Accounts 1400 and 2200 are now in every new business's chart. An older business gets them created the first time it needs them, so `npm run db:provision` isn't required.

**The monthly summary.** `GET /businesses/:businessId/vat/summary?from=2026-11-01&to=2026-11-30` (at most 366 days) adds up issued, part-paid and paid invoices and bills dated in the period. Drafts and voided ones are left out.
- **Output VAT:** invoices, by rate, with the taxable value and the VAT.
- **Input VAT:** bills whose VAT was claimed, by rate.
- **Net:** output less input; above zero is VAT to pay, below zero is carried forward.
- **Documents:** each invoice and bill with its date, number, contact, the contact's BIN, subtotal and VAT, which is what the return's sale and purchase lists ask for.

**The PDF.** An invoice with VAT is titled **Tax invoice** (কর চালান), with a VAT column showing each line's rate and amount, and Subtotal and VAT rows above the total.

**Not covered:** VAT on sales and purchases recorded only as plain transactions (not as invoices), supplementary duty, VAT deducted at source, and filing the return. The summary is a help for the person filing it.

**Permissions:** the summary needs `finance.read`.

**Database.** Migration `20261111090000_vat`: VAT columns on `invoices` and `invoice_lines`, the subtotal of every existing invoice set to its total, a check that the total is subtotal + VAT, and an index by date for the summary. Run `npm run db:deploy` on Neon.

**How it was checked.** 7 new tests (`tests/vat.test.ts`): rounding half up; the posting rules balance with VAT on either side; a registered invoice posts to receivables, sales and VAT Payable; VAT refused when not registered, also at issue; a bill's VAT claimed into 1400 when registered and added to the expense when not; the summary by rate, leaving out drafts, voids and other months, with the right net and document list, and a bad period refused; the PDF; and the permission. All 780 tests pass.

### Step 11.7: Saved items (no stock)

**Why not products and stock.** This was planned as "products and stock". Counting stock properly means quantities on hand, goods received against bills, cost of goods sold (average or first-in-first-out), stock counts and adjustments, units and warehouses. That turns a money app into an ERP, and shops that need real stock control already use a stock or POS app. So this step saves the typing instead: a list of what the business sells or buys, picked on invoice and bill lines. Stock counting can be added later on top of it if users ask.

**An item** has a name (one per business, whatever the letter case), an optional code or SKU, a unit (pcs, kg, gaj, hour...), a note, a usual selling price and a usual buying price (both before VAT, either can be empty), a VAT rate, and the income and expense categories it goes to. They live under `/businesses/:businessId/items`: add, list (by name; search by name or code; `use=SALE` lists those with a selling price, `use=BILL` those with a buying price; archived on request), one, change, and archive with `isActive: false`. Items are never deleted, so old lines keep their item.

**On invoice and bill lines.** A line can carry `itemId` and `unit`. The item must be this business's and not archived (`ITEM_NOT_USABLE`, with the line number). The item only fills the line in: the description, price, VAT and category on the line are what count, and changing the item later doesn't touch lines already made. The PDF prints the unit after the quantity ("10 pcs").

**What was sold and bought.** Each item comes with totals from issued, part-paid and paid invoices and bills (not drafts or voided ones): the quantity, the amount before VAT, and the number of lines.

**Errors:** `ITEM_NAME_TAKEN` (409, with the other item's id and whether it is archived), `ITEM_NOT_USABLE`, `CATEGORY_TYPE_MISMATCH` (an income category in the expense box, or the other way).

**Permissions and audit:** `finance.read` to see, `finance.write` to change. Audit entries `item.created`, `item.updated`, `item.archived`.

**Database.** Migration `20261112090000_items`: the `items` table with row-level security, a unique name per business ignoring case, checks that prices aren't negative and the VAT rate is 0 to 100%, and `item_id` and `unit` on `invoice_lines`. Run `npm run db:deploy` on Neon.

**How it was checked.** 4 new tests (`tests/items.test.ts`): saving with prices and categories; the same name in other letters refused, another business free to use it and unable to see it; a category on the wrong side refused; listing by name, search by code, `use`, archiving and showing archived; lines carrying the item and unit; sold and bought totals leaving out drafts and voids (12.5 sold over two invoices, 20 bought); an archived item, or another business's, refused on a line; the PDF; and the permissions. All 784 tests pass.

### Step 11.8: Launch basics

The public home page, the pricing page, the terms and the privacy policy are frontend pages (see the frontend README). The backend adds two things for them.

**The trial for the public pages.** `GET /platform/signup` needs no sign-in and gives `trialDays`, `trialPlanKey` and `signupsEnabled`, so the home and pricing pages say "Pro free for 14 days" only when that is what a new account really gets.

**All of a business's data in one file.** `POST /businesses/:businessId/report-exports/data` queues one Excel workbook with everything the business holds, one sheet each: About, Accounts, Categories, Customers and suppliers, Items, Transactions, Invoices and bills, Invoice lines, Invoice payments, Chart of accounts, Journal, Budgets, Goals and Tasks. Money is written as numbers, the header row stays in view while scrolling, and text that looks like a formula (`=Karim`) stays text. Drafts without a number show as `DRAFT-<id>`. Uploaded files are not inside; they stay in Documents. It goes through the same queue, worker, notification and 5-minute download link as other exports, and the file is named `<business>-data-<date>.xlsx`.

Only owners and admins (`business.manage`) can ask for it, with a recent two-step code, 5 times an hour per person. The export is hidden from everyone else's export list, and its download link is refused to them (404) even with the id. Audit entry `business.data_export_requested`.

**No migration** in this step: the data export uses the existing `report_exports` table with the report name `ALL_DATA`.

**How it was checked.** 1 new test in `tests/exports.test.ts`: the workbook's sheet names in order, the business and a customer in it, `=Karim` kept as text, the journal's debits equal to its credits, and an accountant refused, not shown the export, and refused its link. 1 new test in `tests/platform-admin.test.ts` for `GET /platform/signup` following the admin's trial setting. All 785 tests pass.

## What was built in Phase 8

**The goal:** ask questions about your business in English or Bangla, and get answers you can trust, with their source.

**The main rule: the AI never sees your database, and it can't make up a figure.** It only picks from a fixed list of tools, the tools work out the numbers, and every number in the answer is checked against what the tools returned.

### How one question travels
```
"নভেম্বরে আমার আয় কত?"
   │  Signed in? Under the rate limit and daily budget? Looks like an attack?
   ▼
The server works out which businesses you may ask about    <── never the AI
   │
   ▼
The AI picks a tool: get_pnl(1 Nov to 30 Nov)              <── checked like any request
   │
   ▼
The tool reads your books through a read-only role, and works out ৳5,00,000.00
   │
   ▼
The AI writes the sentence
   │
   ▼
Number check: is every number in this answer one the tool gave?
   │  no ──> one chance to fix it ──> still no ──> shows the true figures instead
   ▼
Answer + which business, what period, posted actuals + saved with tokens used
```

### Step 1. The AI provider
`src/app/ai/provider.ts` is the only code that knows which company is used. Anything with an OpenAI-style API fits, so **changing company means changing three settings**: `AI_API_KEY`, `AI_BASE_URL` and `AI_CHAT_MODEL`. The defaults are Groq's free plan.

**Why Groq rather than Gemini's free plan:** [Gemini's free terms](https://aistudio.google.com/docs/terms) say your data improves Google's products, that people may read it, and not to submit confidential information. [Groq says](https://console.groq.com/docs/your-data) it doesn't keep your requests by default, except to investigate failures or abuse. Check both before relying on them, as terms change.

**To switch it on:** create a key at [console.groq.com](https://console.groq.com) and add `AI_API_KEY=...` to `.env`. Without a key, the assistant answers `AI_NOT_CONFIGURED`, and everything else, including document search, still works.

### Step 2. The tools
| Tool | Answers | Needs |
|---|---|---|
| `get_pnl` | Revenue, expenses and profit for a period | `finance.read` |
| `compare_periods` | The change between two periods, with percent | `finance.read` |
| `get_balances` | Each account's balance, today or on a past date | `finance.read` |
| `expense_by_category` | Spending by account, largest first | `finance.read` |
| `cash_flow` | Operating, investing and financing cash | `finance.read` |
| `upcoming_obligations` | Bills and salaries coming up, labelled as plans | `finance.read` |
| `budget_status`, `goal_progress` | Limits and targets against actuals | `finance.read` |
| `list_tasks` | Open or overdue tasks | `tasks.read` |
| `search_documents` | What your contracts and invoices say | `documents.read` |
| `list_accounts_and_categories` | Ids needed for a proposal | `finance.read` |
| `propose_transaction`, `propose_task` | A suggestion you confirm | `finance.write` or `tasks.write` |

**Money is worked out in code, and already formatted** by the same `formatMoney` as PDFs, in lakh grouping and your digit style. So the AI never does arithmetic. The tools are tested to agree with the formal reports.

### Step 3. The safety rules
| Rule | How it's enforced |
|---|---|
| **The AI can't change anything** | Its tools use a separate database role, `readonly_ai`, in a read-only transaction with a 5-second limit |
| **It can't read your tables** | That role can read only the `ai_*` views. Not `users`, not `transactions`, not secrets |
| **It can't see another business** | The server picks the businesses. Each tool checks again, and each view filters by the session's list. Tests try all of these |
| **No made-up numbers** | The number check above. Bangla digits and separators don't fool it |
| **Documents can't give it orders** | Their text is labelled as untrusted data. **Once a document has been read, the proposal tools are taken away for the rest of that answer**, so a sentence hidden in a contract can't create a transaction |
| **Obvious attacks never reach it** | "Ignore previous instructions" and SQL are refused first, in English and Bangla |
| **It can't overspend** | 20 questions a minute per person, and `AI_DAILY_TOKEN_LIMIT` per workspace |

**Be realistic about the attack screening:** a list of patterns catches obvious attempts, not clever ones. What protects you is the rest of the table, which holds even if someone fools the AI completely.

### Step 4. Reading your documents
Each upload goes through the worker. **Nothing here leaves your computer, and it costs nothing per document.**

```
Upload ──> check it wasn't swapped ──> malware scan ──> read the text ──> split into passages
                                                                                │
                                         saved in PostgreSQL, with pgvector <── meaning as 384 numbers
```

- **PDF with English text:** read directly, which is fast.
- **Scans, photos, and PDF pages with Bangla:** read with OCR, using Tesseract's Bangla and English data. Text stored in a Bangla PDF usually comes out broken, so those pages are read as images. In testing it read Bangla correctly.
- **Passages:** about 300 words with a 40-word overlap, keeping the page and heading.
- **Meaning:** `multilingual-e5-small` runs on your machine and downloads once, about 120 MB. It trained on Bengali, so a Bangla question finds an English contract.
- **Limits:** OCR reads at most 50 pages of one document, and the audit log records how many were skipped.
- **Earlier uploads** are picked up automatically by a timer. Statements are left out, because their figures belong in the ledger.

**Two gaps from earlier phases are now closed:** a file swapped after upload is refused, because its hash is checked again, and malware scanning exists. Scanning needs a ClamAV server: set `CLAMAV_HOST`. Without one, documents stay `NOT_SCANNED`.

### Step 5. Searching
`GET /businesses/:id/documents/search?q=` **needs no AI key**, so you can try it right away. It combines two searches:

| Search | Good at |
|---|---|
| By meaning | "ভাড়ার চুক্তি" finding "lease agreement" |
| By exact words | An invoice number such as `INV-2041` |

A passage near the top of either list rises. Very common words such as "the" and "হবে" are left out of the word search, because in testing they pushed the wrong documents up.

### Step 6. Proposals
When you say "record 5,000 rent", the AI makes a **suggestion**, and nothing is saved:

```
AI suggests ──> a card waits for you ──> POST /ai/proposals/:id/confirm
                                             │  Normal transaction rules, with today's permissions
                                             ▼
                                         A draft, or posted with postNow. The audit log says via = ai
```

Two clicks create one transaction. Suggestions expire after 7 days, and only the person who asked can confirm one.

### The evaluation set
`evaluation/questions.ts` has 52 real questions, 20 of them in Bangla, each with the right tool and exact figures, checked against known books. They run in two ways:

| | Scripted (`npm test`) | Real (`npm run ai:eval`) |
|---|---|---|
| **Proves** | The right tool gives the right figure, and the checks hold | The real AI picks the right tool and writes it correctly |
| **Needs** | Nothing | `AI_API_KEY` |
| **Cost** | None | Uses your daily quota, so it runs 12 questions by default, 30 seconds apart |

The real run saves `evaluation/last-report.json`, with each question, answer and result. `AI_EVAL_IDS=cmp-1,doc-2` runs just those, and `AI_EVAL_LIMIT=52` runs all of them, which uses most of a day's free quota and takes about 30 minutes.

### What the real AI found
Running it against Groq found problems the scripted tests couldn't, because they only appear when a real model makes its own choices:

| What happened | Why it matters | Fix |
|---|---|---|
| Only the first question worked, then Groq refused the rest | One question used about 5,200 tokens, and the free plan allows 8,000 a minute | Tool descriptions cut by 40%, to about 3,500 tokens a question. The app now waits and retries when told to wait up to 30 seconds |
| It compared 1 Oct to 30 Nov with 1 Oct to 1 Nov, and called ৳8,00,000 "November revenue" | **A wrong answer that passed the number check,** because the tool really returned that figure | The tool refuses overlapping periods, and each result states its own period |
| Correct answers failed the number check for stating a date | It was right to state the period, but the tools didn't return those dates | Period tools now return their dates |
| A payment due on the 5th showed as the 4th | Midnight in Dhaka is still the previous day in UTC | Uses the local date |
| Asked about "that other business", it answered about your own | It wasn't a leak, but it was misleading | It's now told to say it can't see that business, and did |

**What the number check can't do:** it proves a figure came from a tool, not that it was the right tool or period for the question. So the answer's `sources` state the period, and the frontend should show them.

**Free plan limits in practice:** at about 3,500 tokens a question, Groq's 200,000 a day allows roughly 55 questions, and 8,000 a minute allows about 2 a minute. A question that needs a proposal uses about 6,500. A busy minute waits or returns `AI_PROVIDER_BUSY`. These were measured on small test books, and larger results use more.

### Installing on a Linux server
On Linux, the embedding model's runtime also tries to download graphics card (CUDA) files from Microsoft during `npm ci`. The app doesn't use them, and the download can time out, which is what first failed in GitHub Actions. Skip it:

```bash
ONNXRUNTIME_NODE_INSTALL=skip npm ci
```

This was tested in a Linux container: the install succeeded and the model still worked. The CI workflow already sets it.

### New settings in `.env`
| Setting | Purpose |
|---|---|
| `AI_API_KEY` | Switches the assistant on |
| `AI_BASE_URL`, `AI_CHAT_MODEL` | Which company and model. Defaults to Groq |
| `AI_DAILY_TOKEN_LIMIT` | The most one workspace may use in a day. Default 100,000 |
| `CLAMAV_HOST`, `CLAMAV_PORT` | Malware scanning. Off when empty |
| `MODEL_CACHE_DIR` | Where the embedding model is saved. Default `.cache` |

## What was built in Phase 7

**The goal:** get your bank, bKash and Nagad statements into the system and match them to your books, so you can see what's missing and reconcile quickly.

**You don't need a merchant or API account.** The document says most Bangladeshi banks have no public API, and that merchant APIs only show payments made to your merchant account. So it treats statement files as a main path, not a fallback. Download a CSV or Excel statement from your bank or MFS, and everything here works.

### How the pieces connect
```
CSV / Excel file ──┐
Provider API ──────┼─> one standard line ─> skip repeats ─> statement_lines (UNMATCHED)
Provider webhook ──┘   (later, with an account)                  │
                                                                 ▼
                                            1. Already in the books? Link it.
                                            2. A rule fits? Create a transaction.
                                            3. Otherwise: review inbox.
                                                                 │
                                                                 ▼
                                                   Reconciliation clears what's matched
```

**A statement line never changes your books by itself.** It reaches the ledger only through a normal transaction, with all the usual checks. Nothing here can move money either: syncing is read-only.

### Step 1. Upload and preview a statement
1. **Upload it** the same way as other documents, with `type: "STATEMENT"`. CSV or Excel, up to 10 MB and 50,000 rows.
2. **Preview it** with `POST /statement-imports/preview`. With no mapping, it shows the file's columns, a suggested mapping and the date formats that fit. It understands common English and Bangla headings. With a mapping, it shows exactly what would be imported, and changes nothing.
3. **Save the mapping** as a template, so that bank's format only needs working out once.

**A mapping says which column is which:**
```json
{ "headerRow": 3, "dateColumn": "Date", "dateFormat": "DD/MM/YYYY", "descriptionColumn": "Particulars",
  "referenceColumn": "Ref", "debitColumn": "Withdrawal", "creditColumn": "Deposit", "balanceColumn": "Balance" }
```
Use `debitColumn` and `creditColumn`, or one `amountColumn`, where negative means money out. A Dr/Cr column beside it works too, through `directionColumn`.

**It reads what banks really produce:** `1,25,000.50`, `৳1,000`, `(300.00)`, `500 Dr`, Bangla digits, real Excel date cells, UTF-16 files saved by Excel, and semicolon or tab separators. Amounts never pass through a float, so paisa can't drift. A date like `05/06/2026` could be read two ways, so you choose the format rather than the system guessing.

### Step 2. Import it
`POST /statement-imports` queues it, and the worker does the rest.

- **The same file twice adds nothing,** and an overlapping month adds only what's new. Two identical ৳500 withdrawals on one day are both kept.
- **One bad row doesn't stop the rest.** Rows that can't be read are reported by row number. If every row fails, the mapping is wrong, so the import is marked `FAILED`.
- **Balances are checked.** If a row's balance doesn't follow from the one before, `balanceBreaks` counts it. That often means a page is missing from the statement. It warns rather than refuses.
- **The original file is kept** as a document, and each import keeps its own copy of the mapping.

### Step 3. The matcher
Each new line goes through these in order. **A wrong automatic match is worse than asking,** so anything unclear waits for you.

| Step | What it looks for | Result |
|---|---|---|
| 1. Same reference | Same amount, side and reference as a journal line on this account, within 3 days | Linked (`REFERENCE`) |
| 2. Amount and date | Only one possibility, and either the same day or shared words in the description | Linked (`AMOUNT_DATE`) |
| 3. Your rules | Text you chose, such as `facebook` | A draft, or posted with `autoPost` (`RULE`) |
| Otherwise | | Stays in the review inbox |

Reversed entries and journal lines already used are never matched. **An existing entry always beats a rule,** so something you already typed in isn't recorded twice.

**Rules** (`/statement-rules`) are plain text, never patterns, so nobody can write one that slows the server. You can add a maximum amount and a priority. A rule that posts needs `ledger.post`, and an amount above your approval limit still waits for approval. If posting fails, for example in a closed period, the line returns to the inbox with `lastMatchError` saying why.

### Step 4. The review inbox
`GET /statement-lines?status=UNMATCHED` is your to-do list. `GET /statement-lines/:id` also suggests journal lines it might match.

| Action | What it does |
|---|---|
| `/match` | Links existing journal lines. Several can add up to one line, such as a batched deposit |
| `/categorize` | Creates a transaction, as a draft or posted. Or with `transferAccountId`, a transfer to your other account |
| `/split` | Creates several transactions adding up to the line. All or nothing |
| `/ignore`, `/restore` | Leaves a line out, or brings it back |
| `/unmatch` | Removes the link. A transaction it created stays until you void or reverse it |

**Example:** your statement shows ৳1,018.50 leaving the bank, including an ৳18.50 fee, moving to bKash. Categorizing it with `transferAccountId` posts:

| Account | Dr | Cr |
|---|---|---|
| 1130 bKash Wallet | ৳1,000.00 | |
| 6500 Bank & MFS Charges | ৳18.50 | |
| City Bank | | ৳1,018.50 |

An income or expense line puts the whole amount on its category, because this system records fees only on transfers. To show a fee separately on an expense, use `/split`.

**The links stay true as the books change.** Posting a draft settles its line. Voiding a draft, or reversing a matched transaction, sends the line back to the inbox. This runs after each posting, and every 15 minutes.

### Step 5. Reconciliation is now much faster
1. `POST /reconciliations` with the statement's closing balance. `GET` shows `latestStatementBalance` from your import, and `openStatementLines` still to settle.
2. `POST /reconciliations/:id/apply-statement-matches` clears everything already matched, in one call.
3. Close at zero, as before. A line that's part of a reconciliation can't be unmatched.

### Step 6. Connecting a provider, when you have an account
This is built and tested, but **there are no live providers yet**, because there are no credentials to build against.

- **Adding one:** write one adapter file implementing `src/app/integrations/adapter.ts`, and add one line to `registry.ts`. The finance code doesn't change. Each adapter says what it can do, such as `paymentsInOnly`.
- **The practice bank:** the `sandbox` provider runs the whole path with made-up data, so you can try it now in Postman. It's never available in production. Setting `mode` to `revoked`, `flaky` or `broken` makes it fail on purpose.
- **Syncing:** the worker checks every 15 minutes for connections that are due, or use **Sync now**. Only one sync runs per connection at a time. Lines and the cursor save together, so a crash resumes with no gap and no repeats.
- **When it fails:**

| Failure | What happens |
|---|---|
| Timeout, 5xx or 429 | Retries up to 5 times with growing, randomised delays. After that the job stays in the failed list (the dead-letter queue) and goes to Sentry |
| 401 or revoked | Stops at once, sets `NEEDS_REAUTH`, tells the managers. Only new credentials restart it |
| A bad request | Stops at once, with no retry |
| 3 failures in a row | Alerts the managers |

- **Secrets:** encrypted with a key unique to each workspace, and tied to that connection. They're never returned by the API. Passwords, PINs and OTPs are refused, because each adapter accepts only its own named fields.
- **Webhooks:** `POST /webhooks/integrations/:connectionId` checks the provider's signature and timestamp against the exact bytes sent, saves the call and answers quickly. A webhook only triggers a sync, so even a forged one couldn't add a statement line.
- **Raw data:** what a provider sends is stored for 30 days to help investigate problems, with secrets removed and phone and account numbers masked.
- **History:** `GET /integrations/connections/:id/sync-runs`, and every connection change is in the audit log.

### Who can do what
| Action | Permission |
|---|---|
| Import statements, review lines, templates, rules | `finance.write` (Owner, Admin, Accountant) |
| Rules with `autoPost`, and `postNow` | Also `ledger.post` |
| Reading lines and imports | `finance.read` |
| Connections, secrets and syncing | `integrations.manage` (Owner, Admin) |

### Trying it
Download a real statement from your bank as CSV, then follow Postman folders 37 and 38. Folder 39 uses the practice bank. Please send me the column headings of your bank's file if the suggested mapping gets them wrong, without any account numbers or amounts.

## What was built in Phase 6

**The goal:** the system now reaches out to you. Tasks and reminders that can't be lost, recurring transactions and salaries that run themselves, and email, in-app and push notifications in English and Bangla.

### How the pieces connect
```
                      Something happens
   (task assigned, budget reached, reminder due, salary failed...)
                               │
                               ▼
     notifications table + one delivery row per channel   <── saved in a transaction
          │                    │                  │
       IN_APP                EMAIL              PUSH
   shown straight away    worker relay every 2 seconds moves
   + live stream (SSE)    what's due to BullMQ, then sends it
```

### Step 1. Tasks
`POST /businesses/:id/tasks` creates a task with a title, description, assignee, priority and due date. The assignee must be an active member of the business.

```
TODO ⇄ IN_PROGRESS ──> DONE
  │        │             │
  └─ BLOCKED / CANCELLED  └─ can be reopened, which goes back to TODO
```

- **Views:** `?mine=true`, `?overdue=true` and a date range on the list, `/summary` for counts, `/calendar` for tasks and reminders by day, and `GET /tasks` across every business you can read.
- **Comments and attachments:** comments can't be edited, and the database refuses it. Attachments reuse Phase 3's documents.
- **Audited:** creating, changing, assigning and commenting all write to the audit log.

### Step 2. Reminders
A reminder fires once, or repeats by an RFC 5545 rule such as `FREQ=MONTHLY;BYMONTHDAY=1`. You choose the timezone, the channels, who receives it and how long ahead (`leadMinutes`).

**PostgreSQL is the source of truth, and BullMQ only holds the next firing:**
1. Saving a reminder writes `next_fire_at` and an outbox event.
2. The worker makes a delayed job whose id comes from the reminder and that time, so repeating this never makes a second job.
3. When the job runs it locks the reminder. **If the time no longer matches, the job is out of date and is discarded.** That is why editing or pausing a reminder doesn't need to find the old job.
4. It sends the notification, works out the next time and queues it, or marks the reminder `COMPLETED`.

**Reminders can't be lost.** Every 5 minutes a reconciler rebuilds any job missing from Redis. The reconciler's own timer also lives in Redis, so the worker checks every minute and puts it back. This was tested for real by emptying Redis with a reminder pending: it fired on time.

**Automatic reminders:** a task with a due date gets one a day ahead, or at the due time if that's sooner. A schedule with `remindDaysBefore` gets one at 09:00 local time. These follow their task or schedule, and can't be edited by hand.

**Good to know:**
- Rules can repeat hourly at most, so nothing can flood people. An impossible rule such as 30 February is treated as having no more dates.
- A daily reminder stays at the same local time when clocks change. Bangladesh has no clock changes, but other businesses might.
- A worker that was down for a week sends one message, not seven. Bills are remembered through schedules, which do catch up.

### Step 3. Overdue scan
Every 15 minutes the worker looks for open tasks past their due date and tells the assignee, or the creator if nobody is assigned. Each task notifies **once per day** in the business's timezone.

### Step 4. Notifications
Each notification stores a **type and values, never a sentence**, for example `budget.threshold` with `{ percent: 80 }`. The frontend words it in the reader's language. Only email and push are worded by the backend, in `src/app/notifications/templates.ts`, which holds English and Bangla for each type.

| What happens | Who hears | Channels |
|---|---|---|
| Task assigned | The new assignee, unless they assigned themselves | In-app, email, push |
| Comment on a task | Assignee and creator, not the comment's author | In-app, email, push |
| Task overdue | Assignee, or creator | In-app, email, push |
| Reminder due | Its recipient | Those chosen on the reminder |
| Transaction waiting for approval | Everyone who can approve, except the submitter | In-app, email, push |
| Budget threshold, goal achieved | Everyone with `finance.read` | In-app, email, push |
| Recurring transaction failed | Whoever set it up | In-app, email, push |
| Report export ready or failed | Whoever asked | In-app |
| Ledger or audit check failed | Managers or owners | In-app, email, push, ignoring preferences |
| Invitation, password reset, password changed, account locked, stolen session | That person | Email only, ignoring preferences |

**Preferences** (`/notifications/preferences`): switch email or push off, and set quiet hours. During quiet hours email and push wait until the end, while in-app still appears. Security emails ignore these settings.

**Every send is recorded:** `GET /notifications/:id/deliveries` shows each channel's status, attempts and last error.

**Sending twice can't happen by accident.** A unique key on each notification and one delivery row per channel match the document's `(reminder_id, fire_at, channel)` rule. A send that fails retries up to 5 times with growing delays. One rare case remains: if the worker dies between the mail server accepting an email and saving `SENT`, that email goes out twice. Email offers no way to fully rule this out.

**Live updates:** `GET /notifications/stream` is Server-Sent Events. The worker publishes through Redis, and the API passes it to the browser. It closes when the access token expires, so a signed-out user can't keep listening, and the browser reconnects with a new token. Each person can hold 5 streams.

**Web push:** set the VAPID keys in `.env`. Only real browser push services are accepted as addresses. Otherwise someone could make the server call its own internal network.

### Step 5. Recurring transactions and salaries
`POST /businesses/:id/recurring-schedules` repeats a transaction by a rule.

```json
{ "name": "Office rent", "rrule": "FREQ=MONTHLY;BYMONTHDAY=1", "startDate": "2026-12-01",
  "accountId": "...", "categoryId": "...", "amountMinor": "3000000",
  "autoPost": true, "remindDaysBefore": 3 }
```

**On the 1st, this posts:**

| Account | Dr | Cr |
|---|---|---|
| 6100 Rent | ৳30,000 | |
| 1110 City Bank | | ৳30,000 |

- **`autoPost: false`** (the default) leaves a draft for someone to check.
- **Every occurrence goes through the normal transaction rules,** including approval limits and closed periods. An amount above the approval limit waits for a person, even with `autoPost`.
- **Each runs as the person who set it up, with what they may do today.** If their permissions were reduced, it fails. If they left the business, it pauses and tells the owners.
- **One occurrence can never make two transactions,** because of a unique `(schedule, date)` row and an idempotency key. This was tested with two runs at the same moment.
- **Missed dates catch up,** each on its own date, because a bill was still owed. Up to 12 per pass. A paused schedule that resumes looks forward instead.
- **A refusal doesn't stop later dates.** It's recorded as a `FAILED` run and the person is told, and nothing is recorded for that date.
- **`POST .../run`** runs whatever is due now, without waiting for the 5-minute timer.

**Salaries:** `kind: "SALARY"` is the same thing, always posting to **6000 Salaries Expense**. Make one schedule per employee, or one for the whole payroll. Withholding (2100 Payroll Liabilities) isn't included, because the document places employees and payslips in its future Payroll module.

### Step 6. Password reset and security emails
- **`POST /auth/password/forgot`** answers the same whether or not the email has an account, so nobody can test which emails exist.
- **The link lasts one hour and works once.** Only its hash is stored, and asking again cancels the earlier link.
- **Resetting signs out every session** and emails a notice.
- **Lockouts, reused session tokens and password changes now send an email**, at most one per hour of each kind.
- **Invitations are emailed.** The token is still returned to the inviter, in case you want to share it by hand.

Secret links travel through the database and Redis encrypted, and are only decrypted just before sending. A test confirms the readable token isn't in the stored rows.

### Step 7. Timed jobs
All in the worker, on the `maintenance` queue, in Bangladesh time:

| Job | When | What it does |
|---|---|---|
| `reminders.reconcile` | Every 5 min | Rebuilds missing reminder jobs and sends lost from Redis |
| `recurring.run-due` | Every 5 min | Runs schedules that are due |
| `tasks.overdue-scan` | Every 15 min | Tells people about overdue tasks |
| `ledger.verify` | 02:00 | The same check as `npm run ledger:verify` |
| `audit.verify` | 02:30 | The same check as `npm run audit:verify` |
| `system.clean-up` | 03:00 | Removes old data, listed below |

**If a nightly check finds a problem,** it goes to the logs and Sentry, and managers or owners get an alert.

**The clean-up removes:** expired idempotency keys, abandoned uploads (after 1 day), published events (30 days), report exports and their files (30 days), notifications (180 days) and expired password links (7 days). An event not yet published is never removed.

### Step 8. Queue screen
Set `BULL_BOARD_PASSWORD` in `.env` (at least 12 characters), restart the API, and open http://localhost:5001/admin/queues, signing in as `admin`. It shows every queue, including failed jobs, and can retry them. **It's off unless you set a password.** It uses a password rather than a role because queues hold every business's jobs, so use HTTPS in production.

### New settings in `.env`
All optional. Whatever you leave empty is switched off, and is recorded as `SKIPPED` rather than failing.

| Setting | Purpose |
|---|---|
| `APP_URL` | Your web app's address, for links in emails |
| `SMTP_URL`, `EMAIL_FROM` | Your mail server. `smtp://localhost:1025` is Mailpit in development |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web push. Generate with `npx web-push generate-vapid-keys` |
| `BULL_BOARD_PASSWORD` | Switches on the queue screen |

## What was built in Phase 5

**The goal:** turn the ledger into answers. Dashboards for one business or all of them, budgets and goals with alerts, and files you can hand to an accountant.

### How the pieces connect
```
Posting a journal
 ├─ same transaction ─> journal + monthly rollup (trigger) + outbox event
 │                                  │                           │
 │                         dashboards read this          worker publishes it to BullMQ
 │                                                              │
 └─ the request finishes here                     budget check, goal check, report export
```

### Step 1. Monthly rollups
`ledger_monthly_rollups` holds one row per account per month, so dashboards don't scan every journal line. A **database trigger** updates it whenever journal lines are inserted, which means it can't fall behind, adds no extra query when posting, and can't be forgotten by new code. Closing entries are left out, so a closed year's months keep their figures. `npm run ledger:verify` also checks rollups against the journals.

**Dashboards read rollups. Formal reports still read journals directly.** The two are tested to agree.

### Step 2. The outbox and the worker
Some work is too slow for a request, but it also can't be lost. So the event is saved **in the same transaction** as the change, and the worker publishes it to BullMQ every 2 seconds:

- **The change fails:** the event rolls back with it, so it never existed.
- **Redis is down:** events wait in the table and go out when it returns.
- **The worker crashes:** a job retries with growing delays, up to 5 times (3 for exports). Jobs that still fail stay in the failed list, which acts as the dead-letter queue, and final failures go to Sentry.
- **An event is delivered twice:** every handler is safe to run again.

Run `npm run worker` alongside the API. Only one is needed, but several can run safely.

### Step 3. Business dashboard
`GET /analytics/dashboard` gives revenue, expenses, net profit, cash, receivables, payables, a monthly trend with no gaps, top expenses and account balances. It defaults to the fiscal year so far, and accepts `fromMonth` and `toMonth` (`2026-11`). Profit and cash are always shown separately. Every figure states its currency, dates and `POSTED_ACTUALS`.

`GET /analytics/compare` compares revenue, expenses or net profit between two month ranges, with the change and percentage. The percentage is `null` against zero, because a percentage of nothing has no meaning.

### Step 4. Budgets
A budget covers a month range, with an amount per category. Actuals come **from the ledger** through the account each category posts to, so drafts never count and reversals free the money again.

| Level | Meaning |
|---|---|
| `OK` | Below the alert percentage |
| `NEAR` | At or above `alertPercent` (80 by default) |
| `REACHED` | Exactly at 100% |
| `OVER` | Above 100% |

The worker checks after each posting. Each threshold alerts once per line, shows on the budget, and writes a `budget.threshold_reached` event. Phase 6 sends it as a notification. Two categories sharing one ledger account can't be in the same budget, because the ledger can't tell them apart.

### Step 5. Goals
A goal has a target for revenue, net profit or cash balance over a month range. Progress is worked out when you read it, and the worker marks it `ACHIEVED` when the target is reached. A cash goal uses the balance at its end month, including money from before the goal began.

### Step 6. Consolidated view
`GET /consolidated/dashboard` adds up every business you have `finance.read` on, with a per-business breakdown. **The server works out the list; the client can't send one.** Archived businesses are left out unless you add `includeArchived=true`.

### Step 7. Exchange rates
Rates are typed in by you and belong to your workspace (`POST /exchange-rates`). With businesses in different currencies:

1. You must choose a `reportingCurrency`, or get `REPORTING_CURRENCY_REQUIRED`.
2. The view uses the latest rate on or before the period's last day, stored either way round.
3. No rate gives `FX_RATE_MISSING`, naming the pair and date, rather than a wrong total.
4. The response lists every rate and date it used.

Conversion uses whole-number maths, so nothing passes through a float, and it handles currencies like JPY that have no decimals.

### Step 8. Moving money between your businesses
`POST /consolidated/intercompany-transfers` posts one journal in each business, in a single transaction, so both happen or neither does. It needs `ledger.post` in both.

Shop A pays Shop B ৳30,000:

| Business | Dr | Cr | Amount |
|---|---|---|---|
| Shop A | 1300 Due From Other Businesses | 1100 Cash | 30,000 |
| Shop B | 1100 Cash | 2300 Due To Other Businesses | 30,000 |

Each business's own books show the asset and the debt. **In the consolidated view they cancel out**, so group assets, liabilities, revenue, profit and cash don't change, and the eliminated amount is shown. It can only cancel when you can see both businesses. To undo a transfer, make another one in the opposite direction.

### Step 9. Report exports
`POST /report-exports` queues the trial balance, P&L, balance sheet or cash flow as PDF, Excel or CSV, in English or Bangla. It returns `202` straight away; check its status, then get a 5-minute download link.

| Format | What it does |
|---|---|
| **PDF** | Rendered by headless Chrome with an embedded Noto Sans Bengali font, because simple PDF libraries break Bangla conjuncts. Uses `formatMoney`: ৳, lakh and crore grouping, Bangla digits if chosen. JavaScript is off and nothing loads from outside |
| **Excel** | Real numbers people can add up. An amount too large to be exact stays as text |
| **CSV** | UTF-8 with a BOM, so Excel reads Bangla. Headers translate, values stay plain. A name starting with `=`, `+`, `-` or `@` is neutralised, so it can't run as a formula |

Exporting needs `finance.read` and recent MFA. The worker checks access again when it runs, so someone removed in the meantime gets no file. Language defaults to the profile of whoever asked.

## What was built in Phase 4

**The goal:** real double-entry books. Every money movement becomes a balanced journal, posted journals never change, and every report is read from them. This is the document's critical gate: analytics, budgets, integrations and AI all build on it.

**Accounting decision:** the ledger is accrual-ready, but recording is cash-style for now. Receivable and Payable accounts exist, and unpaid invoices or bills can be entered as manual journals, but there's no invoice module yet. Adding one later needs no data migration.

### How double-entry works

Every entry has at least one debit (Dr) and one credit (Cr), and **total debits always equal total credits**. Each account type grows on one side:

| Account type | Grows with | Example |
|---|---|---|
| Asset | Debit | Cash, bank, bKash, money customers owe you |
| Expense | Debit | Rent, salaries |
| Liability | Credit | Money you owe suppliers |
| Equity | Credit | Owner's capital |
| Revenue | Credit | Sales |

### One month, with real entries

Take a new business with a fresh Cash account. Amounts are in taka here; the API stores paisa, so ৳30,000 is `"3000000"`.

| # | What happened | Dr | Cr | Amount |
|---|---|---|---|---|
| 1 | Opened a City Bank account with an existing ৳50,000 | 1110 City Bank | 3900 Opening Balance Equity | 50,000 |
| 2 | Owner puts in capital | 1110 City Bank | 3000 Owner's Equity | 100,000 |
| 3 | Cash sale into the bank | 1110 City Bank | 4000 Sales Revenue | 40,000 |
| 4 | Rent paid from the bank | 6100 Rent Expense | 1110 City Bank | 30,000 |
| 5 | Moved money from bank to bKash, ৳185 fee | 1130 bKash Wallet | 1110 City Bank | 10,000 |
|   | The fee, in the same journal | 6500 Bank & MFS Charges | 1110 City Bank | 185 |
| 6 | Refund to a customer from bKash | 4900 Sales Returns | 1130 bKash Wallet | 2,000 |
| 7 | Invoice issued, not paid yet (manual journal) | 1200 Accounts Receivable | 4000 Sales Revenue | 20,000 |

**Trial balance**, the proof that it balances:

| Account | Debit | Credit |
|---|---|---|
| 1110 City Bank | 149,815 | |
| 1130 bKash Wallet | 8,000 | |
| 1200 Accounts Receivable | 20,000 | |
| 3000 Owner's Equity | | 100,000 |
| 3900 Opening Balance Equity | | 50,000 |
| 4000 Sales Revenue | | 60,000 |
| 4900 Sales Returns | 2,000 | |
| 6100 Rent Expense | 30,000 | |
| 6500 Bank & MFS Charges | 185 | |
| **Total** | **210,000** | **210,000** |

**Profit & loss:** Revenue 58,000 (60,000 less 2,000 returns) − Expenses 30,185 = **net profit ৳27,815**. The ৳10,000 transfer isn't in it, because it only moved money between your own accounts.

**Balance sheet:** Assets 177,815 = Liabilities 0 + Equity 150,000 + unclosed profit 27,815.

**Cash flow:**

| Activity | Amount | Why |
|---|---|---|
| Operating | +7,815 | Sale +40,000, rent −30,000, fee −185, refund −2,000 |
| Investing | 0 | |
| Financing | +100,000 | Capital |
| Opening balances | +50,000 | Reported separately |
| **Cash at the end** | **157,815** | City Bank 149,815 + bKash 8,000 |

Profit is ৳27,815 but operating cash is only ৳7,815. The ৳20,000 gap is the unpaid invoice, which is why the document wants both shown.

**Correcting a mistake:** suppose the rent in step 4 was wrong. Nothing gets edited. `POST /transactions/:id/reverse` adds a mirror image:

| Entry | Dr | Cr | Amount |
|---|---|---|---|
| Original (stays forever) | 6100 Rent Expense | 1110 City Bank | 30,000 |
| Reversal (new) | 1110 City Bank | 6100 Rent Expense | 30,000 |

**Closing the year:** suppose this was the whole year. The closing entry empties revenue and expense, and moves the profit to Retained Earnings, so next year starts at zero:

| Dr | Cr | Amount |
|---|---|---|
| 4000 Sales Revenue | | 60,000 |
| | 4900 Sales Returns | 2,000 |
| | 6100 Rent Expense | 30,000 |
| | 6500 Bank & MFS Charges | 185 |
| | 3200 Retained Earnings | 27,815 |

The closed year's P&L still shows ৳27,815, because the report leaves closing entries out.

### Step 1. Tables
| Table | Purpose |
|---|---|
| `ledger_accounts` | The chart of accounts, in English and Bangla. Each business owns its copy |
| `fiscal_periods` | Twelve monthly periods per year: `OPEN`, `SOFT_CLOSED` or `CLOSED` |
| `journal_entries`, `journal_lines` | The books. Append-only |
| `reconciliations`, `reconciliation_lines` | Statements checked against the books |

All are protected by RLS. Each financial account links to its own asset account, and each category to a revenue or expense account.

### Step 2. The posting engine
`journalsService.post()` in `src/app/modules/journals/journals.service.ts` is **the only code that writes to the ledger**. Inside the caller's transaction it checks the balance, finds the open period, gives the entry a number like `JE-2026-000001`, writes the lines and updates the account's cached balance.

### Step 3. Posting rules
`src/app/utils/postingRules.ts` says how each transaction type becomes lines. They are pure functions, so they can be tested with thousands of random inputs.

| Type | Dr | Cr |
|---|---|---|
| `INCOME` | The account | The category's revenue account |
| `EXPENSE` | The category's expense account | The account |
| `TRANSFER` | Destination account | Source account |
| Transfer fee | 6500 Bank & MFS Charges | Source account |
| `REFUND` | 4900 Sales Returns | The account |
| `ADJUSTMENT` | Same as income or expense, by its category's type | |

Owner capital, drawings, unpaid invoices and bills are manual journals through `POST /journals`.

### Step 4. The transaction lifecycle
```
DRAFT ──post──> POSTED ──reverse──> VOID
  │               ▲
  │             approve (a second person)
  │               │
  └──post──> PENDING_APPROVAL ──reject──> REJECTED     (expense above the threshold)
```

Only posting changes the books, so drafts never appear in a report. `postNow: true` on create does both steps in one request. `approvalThresholdMinor` in the business settings turns on approval, and whoever entered a transaction can't approve it. A sole owner should leave it unset, or they'd have no one to approve.

### Step 5. The books protect themselves
These are enforced by PostgreSQL, so even buggy code can't get past them:

| Rule | How |
|---|---|
| Debits equal credits, with at least 2 lines | Trigger checked at `COMMIT` |
| Each line has exactly one positive side | Check constraint |
| Journals can't be changed or deleted | Triggers, even for the table owner, and the app role has no `UPDATE` or `DELETE` |
| No posting into a closed period, or outside its dates | Trigger |
| No account from another business | Trigger, plus RLS |

### Step 6. Fiscal periods
| Status | Who can post |
|---|---|
| `OPEN` | Anyone with `ledger.post` |
| `SOFT_CLOSED` | Only owners and admins |
| `CLOSED` | Nobody, and it can't reopen |

Months close in order. Closing needs `period.close` and recent MFA. The next fiscal year opens by itself when something is posted into it, up to a year ahead. Older years must be opened with `POST /fiscal-periods/years`. A correction to a closed month is a reversal dated in the current one.

`POST /fiscal-periods/years/:fiscalYear/close` needs every period in the year soft-closed or closed. It posts the closing entry, closes the year and opens the next.

### Step 7. Reports
All read journals only, and each states its dates, currency and `POSTED_ACTUALS`. Every report also returns `balanced`, so a problem shows up in the data.

| Report | Answers |
|---|---|
| Trial balance | Do debits equal credits at this date? |
| Profit & loss | Revenue minus expenses for a range |
| Balance sheet | Assets = Liabilities + Equity at a date |
| Cash flow | Where cash came from and went, by operating, investing and financing |

### Step 8. Reconciliation
Checks a statement against the books. Start one with the statement's balance, match journal lines to it, and watch the difference fall to zero. It only closes at zero, or with `adjust: true`, which books the rest to 6900 and needs `transactions.approve`. Matches are stored in their own table, because journal lines can't change. Phase 7 will feed it from imported statements.

### Step 9. Locks that protect the numbers
- The **fiscal year start month** can't change after creation, because periods are built around it.
- The **base currency** can't change once a journal exists.
- The **opening balance** is now a real journal: Dr the account, Cr 3900.

## What was built in Phase 3

**The goal:** record where money lives and what happened to it, as safe, validated **drafts**. Phase 4 then posts them to the ledger.

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
Accounts are never deleted, only deactivated. Only the last 4 digits of an account number are stored (`****9012`). The opening balance can't be edited after creation, because it's a posted journal.

### Step 5. Transactions
Everything starts as a `DRAFT` with its own number. Drafts can be edited or voided, never deleted. These rules apply on both create and edit:

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
1. An owner or admin calls `POST /businesses/:id/invitations` and gets a token, once. It lasts 7 days. Phase 6 also emails it.
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
| POST | `.../transactions/:transactionId/post` | `ledger.post` | Post to the ledger, or send for approval |
| POST | `.../transactions/:transactionId/approve` | `transactions.approve` | Approve and post |
| POST | `.../transactions/:transactionId/reject` | `transactions.approve` | Reject |
| POST | `.../transactions/:transactionId/reverse` | `ledger.reverse` | Reverse with a mirror-image journal |
| POST | `.../transactions/:transactionId/dismiss-duplicate` | `finance.write` | Clear a duplicate flag |
| POST | `.../transactions/:transactionId/attachments` | `finance.write` | Attach a document |
| DELETE | `.../transactions/:transactionId/attachments/:documentId` | `finance.write` | Remove an attachment |
| POST | `/businesses/:businessId/documents/uploads` | `documents.write` | Get a signed upload URL |
| POST | `/businesses/:businessId/documents/:documentId/complete` | `documents.write` | Check the file and mark it ready |
| GET | `/businesses/:businessId/documents` | `documents.read` | List documents |
| GET | `/businesses/:businessId/documents/:documentId/download` | `documents.read` | Get a download link |
| DELETE | `/businesses/:businessId/documents/:documentId` | `documents.write` | Soft delete |
| GET | `.../analytics/dashboard?fromMonth=&toMonth=` | `finance.read` | One business's dashboard |
| GET | `.../analytics/compare?metric=&fromMonth=&toMonth=&compareFromMonth=&compareToMonth=` | `finance.read` | Compare two ranges |
| POST / GET | `.../budgets` | `finance.write` / `finance.read` | Create or list budgets |
| GET / PATCH | `.../budgets/:budgetId` | `finance.read` / `finance.write` | Against actuals, or rename and archive |
| POST | `.../budgets/:budgetId/lines` | `finance.write` | Add or change a line |
| POST / GET | `.../goals` | `finance.write` / `finance.read` | Create or list goals |
| GET / PATCH | `.../goals/:goalId` | `finance.read` / `finance.write` | Progress, or edit and cancel |
| POST / GET | `.../report-exports` | `finance.read` (+ recent MFA to create) | Queue or list exports |
| GET | `.../report-exports/:exportId` | `finance.read` | Check status |
| GET | `.../report-exports/:exportId/download` | `finance.read` + recent MFA | Download link |
| POST | `.../report-exports/data` | `business.manage` + recent MFA | Queue an Excel file of all the business's data (5 an hour) |
| POST / GET | `/exchange-rates` | Bearer | Save or list your workspace's rates |
| GET | `/consolidated/dashboard?fromMonth=&toMonth=&reportingCurrency=` | Bearer | All businesses you may read |
| POST / GET | `/consolidated/intercompany-transfers` | `ledger.post` in both / Bearer | Move money between businesses, or list |
| GET / POST | `/businesses/:businessId/ledger-accounts` | `finance.read` / `ledger.post` | List or add accounts |
| PATCH | `.../ledger-accounts/:ledgerAccountId` | `ledger.post` | Edit an account |
| GET | `/businesses/:businessId/fiscal-periods` | `finance.read` | List periods |
| POST | `.../fiscal-periods/years` | `period.close` | Open a fiscal year |
| POST | `.../fiscal-periods/:periodId/status` | `period.close` + recent MFA | Soft-close, close or reopen |
| POST | `.../fiscal-periods/years/:fiscalYear/close` | `period.close` + recent MFA | Year-end close |
| GET / POST | `/businesses/:businessId/journals` | `finance.read` / `ledger.post` | List, or post a manual journal |
| GET | `.../journals/:journalId` | `finance.read` | A journal with its Dr and Cr lines |
| POST | `.../journals/:journalId/reverse` | `ledger.reverse` | Reverse a manual journal |
| GET | `.../reports/trial-balance?asOf=` | `finance.read` | Trial balance |
| GET | `.../reports/profit-and-loss?from=&to=` | `finance.read` | Profit & loss |
| GET | `.../reports/balance-sheet?asOf=` | `finance.read` | Balance sheet |
| GET | `.../reports/cash-flow?from=&to=` | `finance.read` | Cash flow |
| POST | `/auth/password/forgot` | none | Email a reset link. Answers the same for any email |
| POST | `/auth/password/reset` | none | Set a new password with the link |
| GET / POST | `/businesses/:businessId/tasks` | `tasks.read` / `tasks.write` | List (`mine`, `overdue`, dates) or create |
| GET | `.../tasks/summary` | `tasks.read` | Counts by status, overdue and assigned to you |
| GET | `.../tasks/calendar?from=&to=` | `tasks.read` | Tasks and reminders by day, up to 62 days |
| GET / PATCH | `.../tasks/:taskId` | `tasks.read` / `tasks.write` | Read, change, or move the status |
| GET / POST | `.../tasks/:taskId/comments` | `tasks.read` / `tasks.write` | List or add comments |
| POST / DELETE | `.../tasks/:taskId/attachments` | `tasks.write` | Attach or remove a document |
| GET | `/tasks` | Bearer | Tasks across every business you can read |
| GET / POST | `/businesses/:businessId/reminders` | `tasks.read` / `tasks.write` | List or create |
| GET / PATCH | `.../reminders/:reminderId` | `tasks.read` / `tasks.write` | Read, change, pause or cancel |
| GET / POST | `/businesses/:businessId/recurring-schedules` | `finance.read` / `finance.write` | List or create (`kind: "SALARY"` for salaries) |
| GET / PATCH | `.../recurring-schedules/:scheduleId` | `finance.read` / `finance.write` | Read with recent runs, change, pause, end |
| POST | `.../recurring-schedules/:scheduleId/run` | `finance.write` | Run what's due now |
| GET | `/notifications` | Bearer | Your in-app notifications |
| GET | `/notifications/unread-count` | Bearer | How many are unread |
| GET | `/notifications/stream` | Bearer | Live updates (Server-Sent Events) |
| POST | `/notifications/:id/read`, `/notifications/read-all` | Bearer | Mark as read |
| GET | `/notifications/:id/deliveries` | Bearer | What happened on each channel |
| GET / PATCH | `/notifications/preferences` | Bearer | Channels and quiet hours |
| GET | `/notifications/push/config` | Bearer | Whether push is on, and its public key |
| GET / POST | `/notifications/push/subscriptions` | Bearer | This browser's push subscription |
| DELETE | `/notifications/push/subscriptions/:id` | Bearer | Stop push to a browser |
| POST | `/businesses/:businessId/statement-imports/preview` | `finance.write` | See columns, a suggested mapping and the result |
| GET / POST | `.../statement-imports` | `finance.read` / `finance.write` | List or import |
| GET | `.../statement-imports/:importId` | `finance.read` | Status, counts and row errors |
| GET / POST | `.../statement-templates` | `finance.read` / `finance.write` | Saved column mappings |
| PATCH / DELETE | `.../statement-templates/:templateId` | `finance.write` | Change or remove |
| GET | `.../statement-lines` | `finance.read` | The review inbox (`status=UNMATCHED`) |
| GET | `.../statement-lines/summary` | `finance.read` | Counts by status |
| POST | `.../statement-lines/run-matcher` | `finance.write` | Try matching open lines again |
| GET | `.../statement-lines/:lineId` | `finance.read` | A line, its links and suggestions |
| POST | `.../statement-lines/:lineId/match`, `/unmatch` | `finance.write` | Link to journal lines, or undo |
| POST | `.../statement-lines/:lineId/categorize`, `/split` | `finance.write` | Create transactions from it |
| POST | `.../statement-lines/:lineId/ignore`, `/restore` | `finance.write` | Leave out, or bring back |
| GET / POST | `.../statement-rules` | `finance.read` / `finance.write` | Rules for categorizing by text |
| PATCH / DELETE | `.../statement-rules/:ruleId` | `finance.write` | Change or remove |
| GET | `.../integrations/providers` | `integrations.manage` | What can be connected |
| GET / POST | `.../integrations/connections` | `integrations.manage` | List or connect (recent MFA) |
| GET / PATCH | `.../integrations/connections/:connectionId` | `integrations.manage` | Read, disable, change how often |
| POST | `.../connections/:connectionId/reauthorize` | `integrations.manage` | New credentials (recent MFA) |
| POST | `.../connections/:connectionId/sync` | `integrations.manage` | Sync now |
| GET | `.../connections/:connectionId/sync-runs` | `integrations.manage` | Sync history |
| POST | `/webhooks/integrations/:connectionId` | Provider's signature | Called by a provider |
| POST | `.../reconciliations/:reconciliationId/apply-statement-matches` | `ledger.post` | Clear everything already matched |
| GET | `/ai/status` | Bearer | Is it on, and today's token use |
| POST | `/ai/chat` | `ai.use` | Ask a question |
| GET | `/ai/conversations`, `/ai/conversations/:id` | Bearer | Your conversations |
| GET | `/ai/proposals` | Bearer | Your suggestions |
| POST | `/ai/proposals/:id/confirm`, `/reject` | Bearer, then the normal permission | Decide on a suggestion |
| GET | `.../documents/search?q=` | `documents.read` | Search by meaning and words, with no AI key |
| POST | `.../documents/:documentId/reindex` | `documents.write` | Read a document again |
| GET / POST | `/businesses/:businessId/reconciliations` | `finance.read` / `ledger.post` | List or start |
| GET | `.../reconciliations/:reconciliationId` | `finance.read` | Difference and unmatched lines |
| POST | `.../reconciliations/:reconciliationId/lines` | `ledger.post` | Match lines |
| DELETE | `.../reconciliations/:reconciliationId/lines/:journalLineId` | `ledger.post` | Un-match a line |
| POST | `.../reconciliations/:reconciliationId/close` | `ledger.post` | Close (`adjust: true` also needs `transactions.approve`) |

Outside `/api/v1`: `GET /health`, `GET /health/ready`, `GET /api/docs`, and `/admin/queues` if switched on.

### Try it

```bash
curl -i -c cookies.txt -H 'Content-Type: application/json' -d '{"name":"Showrov","email":"me@example.com","password":"a-long-password-here"}' http://localhost:5001/api/v1/auth/register
```

Copy `accessToken` from the response, then:

```bash
curl -H 'Authorization: Bearer PASTE_TOKEN_HERE' http://localhost:5001/api/v1/users/me
```

### See a realistic month with Postman
`postman/Business_OS_Demo_Month.postman_collection.json` runs one month for a small shop, **October 2026**, so you can read real-looking reports. Import it, keep `npm run dev` and `npm run worker` running, click **Run**, and keep the requests in order.

Each run creates its own login and business, in whichever database the API is using, and the login appears in Postman's console. It can't be deleted afterwards, because audit rows are permanent. To keep Neon clean, point `.env` at local Docker first. On Neon it will take several minutes.

| What it does | |
|---|---|
| **Set up** | A shop, with City Bank (৳5,00,000) and bKash (৳25,000) opening balances, a budget and a goal |
| **Daily activity** | 12 sales, 14 expenses, 2 transfers including a fee, a refund, and a mistake that's reversed |
| **Plans** | Tasks, including an overdue one, a reminder and a salary schedule |
| **Bank statement** | A CSV import: 15 of 16 lines settle themselves, and the collection categorizes the last |
| **Reconciliation** | Reaches zero, and closes |
| **AI** | English and Bangla questions, if `AI_API_KEY` is set |

**The figures it should reach, checked to the paisa:**
| | October 2026 |
|---|---|
| Revenue | ৳3,43,700.50 |
| Expenses | ৳3,10,989.25 |
| **Net profit** | **৳32,711.25** |
| City Bank | ৳3,42,931.50 |
| bKash | ৳62,400.50 |
| Cash | ৳1,52,379.25 |
| **Total cash** | **৳5,57,711.25** |

To change the month, edit `postman/generate-demo-month.mjs` and run `npm run postman:demo`.

### Test every endpoint with Postman

`postman/Business_OS.postman_collection.json` has 208 requests covering every endpoint, with checks on each response. It saves tokens and generates MFA codes by itself.

**In the Postman app:**
1. Click **Import** and choose that file.
2. Make sure `npm run dev` is running, and `npm run worker` too if you want exports to finish and reminders and notifications to appear. The collection's `baseUrl` variable defaults to `http://localhost:5001`.
3. Open the collection, click **Run**, and keep the requests in order.

**From the terminal:**

```bash
npm run test:postman
```

The last folder pauses for a minute, because the collection reaches the API's limit of 300 requests a minute. Folder 39 uses the practice bank, so it fails against a production build. Each run registers a new `postman...@example.com` user in whichever database the API is using, and audit rows can't be deleted. Point the API at local Docker if you want to keep Neon clean. One request may wait up to 30 seconds, because each MFA code works only once. A run registers 7 times and sign-ups are limited to 10 per 10 minutes, so a second run soon after gets `429`. On local Docker Redis you can clear the limits with:

```bash
docker exec business_os_redis redis-cli flushall
```

## How it was verified

**Phase 8:**
- **735 integration tests pass** (129 of them new), using a scripted stand-in for the AI company.
- **The real embedding model and OCR ran on this Mac** (`npm run test:models`, 9 tests). Bangla questions found English passages and the other way round, and OCR read Bangla from an image and a PDF.
- **The real API and worker were run together,** with the real models and a local stand-in for Groq over real HTTP. A real English PDF, Bangla PDF and scan were all read in about 4 seconds, and the searches above found the right documents. All 333 Postman requests pass with 519 assertions, reaching all 170 documented operations, and no jobs failed.
- **As a role like Neon's owner:** the suite passes, on a database upgraded from Phase 7's tables. The migration adds tables, views and a role, and doesn't change existing rows.
- **The protections were proven real:** switching off RLS on `ai_messages` or `document_chunks`, giving the AI's role access to a table, or removing the business filter from a view each makes the tests fail. Switching off RLS on `ai_proposals` didn't at first, because the code checks too, so a test now checks the database directly.
- **The real AI was tested with Groq's `openai/gpt-oss-120b`, on 23 of the 52 questions, 9 of them in Bangla.** The first 12 scored 11. After fixing what they found, all 23 passed on their most recent run, though not all in one run. See [what the real AI found](#what-the-real-ai-found).
- **Testing caught three real problems:**
  - When OCR couldn't download its data, it crashed the whole worker, not just one job. Fixed, and the language data now ships with the app, so OCR needs no internet.
  - Text stored in a Bangla PDF came out broken, so those pages now go through OCR.
  - Common words pushed the wrong documents up the search results. They're now left out of the word search.

**Phase 7:**
- **606 integration tests pass** (144 of them new), with real uploads to MinIO. They cover amounts and dates in the formats banks use, Excel and UTF-16 files, repeated and overlapping imports, each matching step and when it must not match, three people acting on one line at once, closed periods and reversals.
- **The real API and worker were run together:** all 316 Postman requests pass with 500 assertions, reaching all 161 documented operations, and no jobs failed.
- **A real BullMQ worker** retried a failing sync and left it in the failed list.
- **As a role like Neon's owner:** the whole suite passes, on a database upgraded from Phase 6's tables. The migration only adds tables and one document type, so it doesn't change existing rows.
- **The protections were proven real:** switching off RLS on `statement_lines` or `integration_connections`, or removing the unique rule on statement rows, makes the matching tests fail. Removing the rule that a journal line settles only one statement line didn't at first, because the code checks too, so a test now checks the database rule directly.
- **The tests caught a real accounting mistake of mine:** I had assumed fees post on every transaction. They only post on transfers, and a transfer's fee creates two lines on the account, so linking just one would have thrown off reconciliation. Fixed and tested.

**Phase 6:**
- **462 integration tests pass** (137 of them new).
- **Hard cases are tested:** jobs run twice and at the same moment, stale jobs after an edit, a worker down for a week, closed periods, a creator who left or lost permission, HTML typed into a task title, links used twice at once, and push addresses aimed at the internal network.
- **The real API, worker and mail server were run together** (Mailpit, not a real provider). All 264 Postman requests pass, with 425 assertions, reaching all 129 documented operations, and no jobs failed. Separately, a script confirmed: an invitation email whose link works, a live notification arriving without a refresh, a task reminder firing through BullMQ, a Bangla email, and a full password reset.
- **Redis was emptied for real** with a reminder pending. Within a minute the timers restored themselves and rebuilt the job, and the reminder fired on time.
- **The worker shut down cleanly** on a stop signal.
- **Web push encryption was checked** against a local stand-in for a push service: the message was encrypted and signed, and an unsubscribed browser was recognised.
- **As a role like Neon's owner:** the suite passes, on a database upgraded from Phase 5's tables. The migration only adds tables, so it doesn't touch existing rows.
- **The protections were proven real:** switching off RLS on `tasks` or `notifications`, or removing the unique rule on recurring runs or notification keys, makes the matching tests fail.
- **The production build ran too** (`npm start` and `npm run start:worker`), including the queue screen. The only Postman failures there were the 2 checks of the API docs page, which production doesn't serve on purpose.
- **The tests caught a real bug:** a reminder job running a moment early would have found the same occurrence again and got stuck. Fixed.

**Phase 5:**
- **325 integration tests pass** (63 of them new), covering dashboards against the formal reports, budget and goal thresholds firing once, the outbox failure cases, and consolidation.
- **One test runs a real BullMQ worker:** a posting becomes an event, then a job, then a budget alert.
- **The real API and worker were run together:** all 208 Postman requests pass, reaching all 95 documented operations. The worker finished 14 jobs with none failed, and shut down cleanly.
- **Exports:** downloaded files were opened and checked, including the BOM, Excel values and hostile names. **A Bangla PDF was checked by eye**, and conjuncts, Bangla digits and lakh grouping all render correctly.
- **As a role like Neon's owner:** the suite passes. Dropping the rollup trigger or switching off RLS on budgets makes the tests fail, as they should.
- **Upgrade:** the migration was applied to a Phase 4 database with posted journals, the rollups were backfilled correctly, and `ledger:verify` found no problems.

**Phase 4 (the gate):**
- **262 integration tests pass** (68 of them new), including exact Dr and Cr for each posting rule, simultaneous posting, reversals, approvals, period rules, year-end close, all four reports and reconciliation.
- **Property-based tests with random inputs** (`tests/ledger-properties.test.ts`): 4,000 random postings through the rules, and 15 random sequences of up to 12 transactions and reversals through the real API. After each sequence: debits equal credits, assets equal liabilities plus equity, transfers stay out of profit, cash flow ties out, and cached balances match the ledger.
- **The database protections were proven real:** the suite passes as a role like Neon's owner, and removing the balance triggers or switching off RLS makes the matching tests fail.
- **The upgrade was tested on a Phase 3 database with data**, as that same role: the migration applied, `db:provision` linked everything, a second run changed nothing, and `ledger:verify` found no problems.
- **All 178 Postman requests pass** on the built server, run with Newman on a temporary local database. They reach all 75 documented operations.
- **The worked example in this README is itself a test**, so its figures can't drift from what the code does.
- **Timed with Neon-like delay** (260ms per round trip, simulated locally): creating and posting a transaction took about 8.3 seconds, creating a business about 5.4, and a trial balance about 1.6.

**Phase 3:**
- **194 integration tests pass** (67 of them new), with real file uploads to MinIO. They cover precision on large amounts, simultaneous retries, simultaneous numbering, every transaction rule, fake file types and ids from other businesses.
- **The suite also passes as a role like Neon's owner**, on a temporary PostgreSQL 17 database. With RLS switched off on `financial_accounts`, the tests fail, as they should.
- **All 123 Postman requests pass** on the built server, run with Newman on a temporary local database. They reach all 50 documented operations.
- **Timed with Neon-like delay** (260ms per round trip, simulated locally): creating a draft took about 4.5 seconds, and a list about 1.6.

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
- **29 of the 52 evaluation questions haven't been tried with the real AI,** to save the day's quota. Run them with `AI_EVAL_LIMIT=52 npm run ai:eval` on a fresh day.
- **Real scanned documents.** OCR was tested on clean text rendered by a browser. A phone photo of a crumpled receipt will read worse.
- **A real ClamAV server.** The scanner's protocol was tested against a local stand-in.
- **The Phase 8 migration on Neon,** including `pgvector` there and the `readonly_ai` role.
- **A real bank or MFS statement.** Tests use formats I wrote from what banks commonly produce, so your bank's file may need a mapping adjustment.
- **Any live provider,** because there are no credentials. The sandbox proves the pipeline, not a real bank's API.
- **The Phase 7 migration on Neon** (PostgreSQL 18) hasn't been confirmed. It was tested on PostgreSQL 17.
- **Phase 5 and 6's timing on Neon** hasn't been measured. Posting adds one query for the outbox event, on top of the 8.3 seconds measured in Phase 4.
- **The worker's use of Neon** hasn't been measured. It checks the database every 2 seconds, which will probably stop Neon scaling to zero and can use up compute hours.
- **A real email provider** hasn't been tried, only Mailpit. Real deliverability (spam folders, DKIM) depends on your provider.
- **Web push in a real browser:** there is no frontend yet. Encryption was checked, but no browser has received one.
- **The nightly jobs at their real times:** each was run directly and registered with BullMQ, but none has run overnight.
- **Chrome on GitHub's runners:** the CI workflow installs Chrome and sets `CHROME_NO_SANDBOX`, but hasn't been seen to run.
- **Cloudflare R2 or S3** have not been tried. Uploads were tested on MinIO only.
- **GitHub Actions results** have not been checked.
- **Real Sentry and Grafana accounts** have not been connected.

## What still needs you

1. **Update Neon:** run `npm run db:deploy`, then `npm run ledger:verify`. Phase 11 adds the plans migration (already run on 7 Nov 2026; every existing account is on Pro free with no end date) the payments (11.2), admin panel (11.3), contacts (11.4), invoices (11.5), VAT (11.6, `20261111090000_vat`) and items (11.7, `20261112090000_items`) migrations, all still to run.
   Then make yourself the platform admin: turn on two-step sign-in in the app, and run `npm run admin:grant -- your-email`.
2. **Get a Groq key** from [console.groq.com](https://console.groq.com), add `AI_API_KEY=...` to `.env`, then run `npm run ai:eval` to see how well it really does, especially in Bangla.
3. **Keep the worker running.** Reminders, emails, recurring transactions and document reading all depend on it.
4. **Choose an email provider** before production, and set `SMTP_URL`, `EMAIL_FROM` and `APP_URL`. Without `SMTP_URL`, nothing is emailed, including password resets.
5. **Ask your accountant** whether cash-style recording suits your statutory or tax reports, especially for a registered company.
6. **Choose hosting** at Phase 10. The API and worker each used about 800 to 900 MB once the embedding model had loaded, so plan for at least 4 GB of memory.

## Differences from the architecture document

**Changed on purpose:**
| Document says | Built | Why |
|---|---|---|
| `repository`, `policies`, `events`, `index.ts`, `__tests__` in each module | Only router, controller, service, validation, interface | Your instruction. Services call Prisma directly, and tests live in `tests/` |
| `src/modules`, `src/infrastructure`, `src/shared` | `src/app/modules`, `src/lib`, `src/app/utils` | Follows the skeleton you had already started |
| A separate login for the app's database role | One login that switches to `business_os_app` inside business transactions | Login and sign-up need access RLS would block, and this needs no second password |
| Accountant "read own" audit | Uses `GET /audit/me` | Every user already has it, so no extra permission is needed |
| Transfer fee example credits the destination (bKash) | The fee always comes from the source account | One clear rule. To charge the destination instead, post the fee as its own expense |
| Reconciliation difference on 6900 or 4900 | Always 6900 | 4900 is Sales Returns, so a bank difference shouldn't reduce sales |
| A `reconciled_at` column on journal lines | A separate `reconciliation_lines` table | Journal lines can't change, by design |
| Period check when saving a draft | Period check when posting | A draft doesn't touch the books, so it can be saved for any date |
| Materialized views refreshed by a worker | A rollup table kept in step by a trigger | Materialized views refresh all businesses at once and can't use RLS. This is per-business, RLS-protected and never stale |
| Intercompany as two linked transactions | Two linked journals, plus an `intercompany_transfers` row | A transaction needs a category and a single account. The journals are what matter for the books |
| `X-Business-Id` header mentioned in one diagram | Business id in the URL | The document's other sections use the URL, and it keeps routes explicit |
| ESLint rule blocking deep imports through `index.ts` | Not added | There is no `index.ts`. By convention, modules only import each other's services |
| `minio/minio` image | `cgr.dev/chainguard/minio` | The official image was refused on Docker Hub and Quay (Nov 2026) |
| Progressive login delay | Fixed lockout after 5 failures | Simpler, and it covers the same threat |
| A separate "intent" step before choosing tools | The AI picks tools directly | Same result with fewer tokens, which matters on a free plan |
| A separate AI re-ranking step | Combined ranking from both searches | Needs no extra model or tokens. Worth revisiting if search misses things |
| Passages of about 800 tokens | About 300 words | This embedding model reads at most 512 tokens and ignores the rest |
| OCR data downloaded when needed | OCR data ships as npm packages | Works offline, and can't fail because a website is busy |
| Answers streamed as they're written | The whole answer at once | Simpler. Worth adding in Phase 9 if waiting feels slow |
| FX conversion in the AI's figures | Totals kept per currency | Adding taka and dollars needs a rate you chose, which the consolidated dashboard already handles |
| Keys held in a KMS or Vault | One key per workspace, derived from your master key | Needs no extra service. Moving to a KMS later changes only `crypto.ts` |
| Auto-post "per business setting" | Set on each rule | Some rules are safe to post and some aren't, so one business-wide switch is too blunt |
| One hash on date, amount, reference and balance | The same, plus a counter for repeats | Otherwise two identical withdrawals on one day would become one |
| Counterparty matched to a counterparty record | Matched on words in the description | Counterparties aren't in any phase's list yet |
| MJML email templates, one file per language | One TypeScript file with both languages | Email wording is short, and this adds no build step. Easy to change if emails get more complex |
| Task status `TODO → IN_PROGRESS → DONE` | Also `TODO → DONE`, and reopening | Small tasks often skip a step, and mistakes need undoing |
| "Mark overdue" on the task | `isOverdue` worked out when read | A stored flag would go stale between scans |
| Salary schedules | A recurring expense on 6000 Salaries | Employees and withholding are in the document's future Payroll module |

**Moved to a later phase:**
| Item | Phase | Why |
|---|---|---|
| Foreign-currency accounts inside a business | When needed | **Moved from Phase 5.** Accounts in another currency can exist, but posting returns `FOREIGN_CURRENCY_NOT_SUPPORTED`. A business in USD works, and consolidation converts it. Doing this properly needs exchange gains and losses, which no phase covers |
| Fetching exchange rates automatically | When needed | You type them in, which keeps every figure traceable |
| Exports of the consolidated view | When needed | The document's exports are per business |
| Live bank, bKash and Nagad adapters | When you have credentials | The document builds these only where credentials exist. Adding one touches one file and one line |
| Reminders from bills' due dates and from documents | Future, 8 | Bills don't exist yet, and reading deadlines from documents needs Phase 8's ingestion |
| Salary withholding, employees, payslips | Future | The document's Payroll module. Salary schedules post the gross amount for now |
| Custom notification choices per type | When needed | Preferences are per channel. The document only asks for channels and quiet hours |
| Invoices, bills, and receivable and payable tracking | Future | Accrual-ready: the accounts exist, and manual journals work today |
| AI reading invoices into suggested transactions and reminders | When needed | The document marks this optional. OCR's text is ready for it |
| Charts in AI answers | 9 | Needs the frontend. Figures come back as text and sources for now |
| Enforcing `enabledModules` per business | SaaS | The setting is stored, but nothing reads it yet |
| Counterparties (customers and suppliers) | Not in any phase's list | The ER diagram has the table, but no phase includes the module. `counterparty_id` is added when it's built |
| Custom fields | Not in any phase's list | Section 8.4 describes them, but no phase includes them |
| Plan limits and custom roles | SaaS | The tables already allow custom roles; no endpoint yet |
| Monthly partitions on `audit_logs` | Later | A scaling step, not needed at this size |
| Grafana, Loki and Tempo containers | 10 | The app already exports telemetry; only the receiving side is missing |

**Known gap:** an upload URL stays valid for its full 15 minutes, even after the file is marked `READY`. Someone holding the link could replace the file with another of the same size and type. Phase 8 refuses it if the worker reads it after the swap, but a swap after the worker has read it isn't noticed.

**Known gap:** the document has no MFA recovery codes. Password reset keeps MFA on, as it should, so a user who loses their authenticator can still only be recovered by editing the database. Consider adding recovery codes before relying on MFA in production.

**Known gap:** the Phase 6 stream authenticates once when it opens. A session revoked during those 15 minutes keeps receiving until the token's life ends.

## Before Phase 9

Phase 9 builds the React frontend: sign-in, the business switcher, dashboards with charts, finance, ledger, reports, tasks, documents, the review inbox, the AI panel, settings and the audit viewer. Nothing new is needed from you to start. Running `npm run ai:eval` first would show whether the AI needs changing before it gets a screen.
