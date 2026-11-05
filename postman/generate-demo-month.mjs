// Builds Business_OS_Demo_Month.postman_collection.json. Edit this file, not the JSON, then run:
//   npm run postman:demo
// One realistic month for a small shop. Every expected figure below is worked out from this data, so
// when the collection's checks pass, the app agrees with this arithmetic to the paisa.
import fs from "node:fs";

const out = new URL("./Business_OS_Demo_Month.postman_collection.json", import.meta.url);

const taka = (amount) => String(Math.round(amount * 100));
const OPENING = { bank: 500_000, bkash: 25_000 };

// date, type, account, category, amount, reference, description
const SALES = [
  ["2026-10-01", "cash", 18_500, "CASH-1001", "দোকানে নগদ বিক্রি"],
  ["2026-10-03", "bkash", 12_750, "BK-2201", "bKash payment from retail customers"],
  ["2026-10-05", "bank", 45_000, "INV-3001", "Wholesale order, Rahman Stores"],
  ["2026-10-07", "cash", 21_300, "CASH-1002", "দোকানে নগদ বিক্রি"],
  ["2026-10-10", "bank", 62_500, "INV-3002", "Wholesale order, Karim & Sons"],
  ["2026-10-12", "bkash", 9_850.5, "BK-2202", "bKash payment from retail customers"],
  ["2026-10-15", "cash", 26_400, "CASH-1003", "দোকানে নগদ বিক্রি"],
  ["2026-10-18", "bank", 38_200, "INV-3003", "Wholesale order, Dhaka Mart"],
  ["2026-10-21", "cash", 19_950, "CASH-1004", "দোকানে নগদ বিক্রি"],
  ["2026-10-24", "bkash", 14_300, "BK-2203", "bKash payment from retail customers"],
  ["2026-10-27", "bank", 51_000, "INV-3004", "Wholesale order, Rahman Stores"],
  ["2026-10-30", "cash", 23_650, "CASH-1005", "দোকানে নগদ বিক্রি"],
];

const EXPENSES = [
  ["2026-10-02", "bank", "Purchases", 85_000, "PO-501", "Stock from Noor Traders"],
  ["2026-10-02", "cash", "Transport", 1_250, "", "ডেলিভারি ভ্যান ভাড়া"],
  ["2026-10-04", "bank", "Rent", 30_000, "CHQ-7701", "দোকান ভাড়া, অক্টোবর"],
  ["2026-10-06", "cash", "Office Supplies", 2_340.75, "", "Receipt books and packing tape"],
  ["2026-10-08", "bkash", "Marketing", 4_500, "FB-22", "Facebook ads"],
  ["2026-10-09", "bank", "Utilities", 6_820, "DESCO-1", "বিদ্যুৎ বিল, সেপ্টেম্বর"],
  ["2026-10-11", "cash", "Transport", 980, "", "রিকশা ও ভ্যান ভাড়া"],
  ["2026-10-14", "bank", "Purchases", 64_300, "PO-502", "Stock from Noor Traders"],
  ["2026-10-16", "bkash", "Software & Subscriptions", 1_200, "POS-OCT", "POS software, monthly"],
  ["2026-10-19", "cash", "Other Expenses", 1_650, "", "চা ও আপ্যায়ন"],
  ["2026-10-22", "bkash", "Marketing", 3_800, "FB-23", "Facebook ads"],
  ["2026-10-25", "bank", "Utilities", 2_150, "ISP-10", "Internet bill"],
  ["2026-10-28", "bank", "Purchases", 41_750, "PO-503", "Stock from Noor Traders"],
  ["2026-10-31", "bank", "Salaries", 65_000, "SAL-OCT", "অক্টোবরের বেতন, ৩ জন কর্মী"],
];

const CASH_FROM_BANK = 50_000;
const BKASH_TRANSFER = { amount: 10_000, fee: 18.5 };
const REFUND = { date: "2026-10-13", account: "cash", amount: 1_200, description: "Returned goods, cash refund" };
const MISTAKE = { date: "2026-10-17", account: "cash", amount: 7_777, description: "Typed by mistake, then reversed" };

// On the bank statement, but not typed in by anyone.
const SERVICE_CHARGE = { date: "2026-10-31", amount: 230, description: "BANK SERVICE CHARGE" };
const UNKNOWN_DEPOSIT = { date: "2026-10-29", amount: 1_500, description: "CASH DEPOSIT, BRANCH" };

// ---------------------------------------------------------------------------
// The expected figures
// ---------------------------------------------------------------------------
const sum = (rows, pick) => rows.reduce((total, row) => total + pick(row), 0);
const salesTotal = sum(SALES, (row) => row[2]);
const expensesTyped = sum(EXPENSES, (row) => row[3]);
const revenue = salesTotal - REFUND.amount + UNKNOWN_DEPOSIT.amount;
const expenses = expensesTyped + BKASH_TRANSFER.fee + SERVICE_CHARGE.amount;
const netProfit = revenue - expenses;

const moved = (account) =>
  sum(SALES.filter((row) => row[1] === account), (row) => row[2]) - sum(EXPENSES.filter((row) => row[1] === account), (row) => row[3]);

const cashEnd = CASH_FROM_BANK + moved("cash") - REFUND.amount;
const bkashEnd = OPENING.bkash + BKASH_TRANSFER.amount + moved("bkash");
const bankEnd = OPENING.bank - CASH_FROM_BANK - BKASH_TRANSFER.amount - BKASH_TRANSFER.fee + moved("bank") - SERVICE_CHARGE.amount + UNKNOWN_DEPOSIT.amount;
const totalCash = cashEnd + bkashEnd + bankEnd;
const rentSpent = sum(EXPENSES.filter((row) => row[2] === "Rent"), (row) => row[3]);
const marketingSpent = sum(EXPENSES.filter((row) => row[2] === "Marketing"), (row) => row[3]);

// The bank's own statement, in date order.
const bankRows = [
  ["2026-10-01", "Transfer to cash", "TRF-1", -CASH_FROM_BANK],
  ["2026-10-20", "Transfer to bKash", "TRF-2", -BKASH_TRANSFER.amount],
  ["2026-10-20", "Transfer fee", "TRF-2F", -BKASH_TRANSFER.fee],
  ...SALES.filter((row) => row[1] === "bank").map((row) => [row[0], row[4], row[3], row[2]]),
  ...EXPENSES.filter((row) => row[1] === "bank").map((row) => [row[0], row[5], row[4], -row[3]]),
  [SERVICE_CHARGE.date, SERVICE_CHARGE.description, "", -SERVICE_CHARGE.amount],
  [UNKNOWN_DEPOSIT.date, UNKNOWN_DEPOSIT.description, "", UNKNOWN_DEPOSIT.amount],
].sort((a, b) => a[0].localeCompare(b[0]));

const toBankDate = (iso) => iso.split("-").reverse().join("/");
let running = OPENING.bank;
const STATEMENT = [
  "City Bank PLC,,,,,",
  "Statement of account: October 2026,,,,,",
  "Date,Particulars,Ref,Withdrawal,Deposit,Balance",
  ...bankRows.map(([date, details, reference, amount]) => {
    running += amount;
    return [toBankDate(date), `"${details}"`, reference, amount < 0 ? (-amount).toFixed(2) : "", amount > 0 ? amount.toFixed(2) : "", running.toFixed(2)].join(",");
  }),
  `Closing balance,,,,,${running.toFixed(2)}`,
].join("\n") + "\n";

if (running !== bankEnd) throw new Error(`the statement ends at ${running}, but the bank should end at ${bankEnd}`);

const MAPPING = { headerRow: 3, dateColumn: "Date", dateFormat: "DD/MM/YYYY", descriptionColumn: "Particulars", referenceColumn: "Ref", debitColumn: "Withdrawal", creditColumn: "Deposit", balanceColumn: "Balance" };

// ---------------------------------------------------------------------------
// Building requests
// ---------------------------------------------------------------------------
const status = (...codes) => `pm.test("status is ${codes.join(" or ")}", () => pm.expect([${codes.join(",")}]).to.include(pm.response.code));`;

const req = (name, method, path, { auth = true, body, raw, contentType = "application/json", tests = [], pre } = {}) => ({
  name,
  event: [
    ...(pre ? [{ listen: "prerequest", script: { type: "text/javascript", exec: pre.split("\n") } }] : []),
    { listen: "test", script: { type: "text/javascript", exec: tests.join("\n").split("\n") } },
  ],
  request: {
    method,
    auth: auth ? { type: "bearer", bearer: [{ key: "token", value: "{{demoToken}}", type: "string" }] } : { type: "noauth" },
    header: body || raw ? [{ key: "Content-Type", value: contentType }] : [],
    ...(body ? { body: { mode: "raw", raw: JSON.stringify(body, null, 2) } } : {}),
    ...(raw ? { body: { mode: "raw", raw } } : {}),
    url: path.startsWith("{{") ? path : `{{baseUrl}}${path}`,
  },
});

const API = "/api/v1";
const BIZ = `${API}/businesses/{{demoBusinessId}}`;

// Access tokens last 15 minutes, and a slow database can make this run longer than that.
const signIn = () =>
  req("Sign in again (tokens last 15 minutes)", "POST", `${API}/auth/login`, {
    auth: false,
    body: { email: "{{demoEmail}}", password: "{{demoPassword}}" },
    tests: [status(200), `pm.collectionVariables.set("demoToken", pm.response.json().data.accessToken);`],
  });

const ACCOUNT_IDS = { cash: "{{cashId}}", bank: "{{bankId}}", bkash: "{{bkashId}}" };
const postedTest = [status(201), `pm.test("posted to the ledger", () => pm.expect(pm.response.json().data.status).to.eql("POSTED"));`];

const categoryVariable = (name) => `cat${name.replace(/[^A-Za-z]/g, "")}`;

const money = (amount) => `৳${amount.toLocaleString("en-IN")}`;

const saleRequests = SALES.map(([date, account, amount, reference, description]) =>
  req(`Sale ${date}: ${money(amount)} (${account})`, "POST", `${BIZ}/transactions`, {
    body: { postNow: true, type: "INCOME", accountId: ACCOUNT_IDS[account], categoryId: "{{catSales}}", amountMinor: taka(amount), txnDate: date, referenceNo: reference, description },
    tests: postedTest,
  }),
);

const expenseRequests = EXPENSES.map(([date, account, category, amount, reference, description]) =>
  req(`${category} ${date}: ${money(amount)} (${account})`, "POST", `${BIZ}/transactions`, {
    body: { postNow: true, type: "EXPENSE", accountId: ACCOUNT_IDS[account], categoryId: `{{${categoryVariable(category)}}}`, amountMinor: taka(amount), txnDate: date, ...(reference ? { referenceNo: reference } : {}), description },
    tests: postedTest,
  }),
);

const CATEGORIES = [...new Set(["Sales", "Other Income", "Bank & MFS Charges", ...EXPENSES.map((row) => row[2])])];

const item = [
  { name: "1. Set up the shop", item: [
    req("Create your demo login", "POST", `${API}/auth/register`, {
      auth: false,
      pre: `const email = "demo" + Date.now() + "@example.com";
pm.collectionVariables.set("demoEmail", email);`,
      body: { name: "Demo Owner", email: "{{demoEmail}}", password: "{{demoPassword}}", locale: "en" },
      tests: [status(201), `pm.collectionVariables.set("demoToken", pm.response.json().data.accessToken);
console.log("Demo login:", pm.collectionVariables.get("demoEmail"), pm.collectionVariables.get("demoPassword"));`],
    }),
    req("Create the business", "POST", `${API}/businesses`, {
      body: { name: "ঢাকা ডেমো ট্রেডার্স", type: "RETAIL" },
      tests: [status(201), `pm.collectionVariables.set("demoBusinessId", pm.response.json().data.id);`],
    }),
    req("Open the 2026 financial year", "POST", `${BIZ}/fiscal-periods/years`, { body: { fiscalYear: 2026 }, tests: [status(201, 409)] }),
    req("Find the Cash account and categories", "GET", `${BIZ}/categories`, {
      tests: [status(200), `const names = ${JSON.stringify(Object.fromEntries(CATEGORIES.map((name) => [name, categoryVariable(name)])))};
for (const category of pm.response.json().data) {
  if (names[category.name]) pm.collectionVariables.set(names[category.name], category.id);
}
pm.test("every category exists", () => Object.values(names).forEach((name) => pm.expect(pm.collectionVariables.get(name)).to.be.a("string")));`],
    }),
    req("Read the Cash account", "GET", `${BIZ}/accounts`, { tests: [status(200), `pm.collectionVariables.set("cashId", pm.response.json().data[0].id);`] }),
    req(`Add City Bank, opening ${money(OPENING.bank)}`, "POST", `${BIZ}/accounts`, {
      body: { name: "City Bank", type: "BANK", openingBalanceMinor: taka(OPENING.bank), openingDate: "2026-10-01", accountNumber: "0012345678" },
      tests: [status(201), `pm.collectionVariables.set("bankId", pm.response.json().data.id);`],
    }),
    req(`Add bKash, opening ${money(OPENING.bkash)}`, "POST", `${BIZ}/accounts`, {
      body: { name: "bKash Merchant", type: "BKASH", openingBalanceMinor: taka(OPENING.bkash), openingDate: "2026-10-01", accountNumber: "01712345678" },
      tests: [status(201), `pm.collectionVariables.set("bkashId", pm.response.json().data.id);`],
    }),
    req("Budget for October", "POST", `${BIZ}/budgets`, {
      body: { name: "অক্টোবর ২০২৬", startMonth: "2026-10", endMonth: "2026-10", lines: [
        { categoryId: "{{catRent}}", amountMinor: taka(35_000), alertPercent: 80 },
        { categoryId: "{{catMarketing}}", amountMinor: taka(10_000), alertPercent: 80 },
      ] },
      tests: [status(201), `pm.collectionVariables.set("budgetId", pm.response.json().data.id);`],
    }),
    req("Goal: ৳3,00,000 revenue in October", "POST", `${BIZ}/goals`, {
      body: { name: "অক্টোবরের বিক্রির লক্ষ্য", metric: "REVENUE", targetMinor: taka(300_000), startMonth: "2026-10", endMonth: "2026-10" },
      tests: [status(201), `pm.collectionVariables.set("goalId", pm.response.json().data.id);`],
    }),
  ]},
  { name: "2. Move money between accounts", item: [
    req(`Bank to Cash: ${money(CASH_FROM_BANK)}`, "POST", `${BIZ}/transactions`, {
      body: { postNow: true, type: "TRANSFER", accountId: "{{bankId}}", toAccountId: "{{cashId}}", amountMinor: taka(CASH_FROM_BANK), txnDate: "2026-10-01", referenceNo: "TRF-1", description: "Cash for the shop" },
      tests: postedTest,
    }),
    req(`Bank to bKash: ${money(BKASH_TRANSFER.amount)}, with a ৳18.50 fee`, "POST", `${BIZ}/transactions`, {
      body: { postNow: true, type: "TRANSFER", accountId: "{{bankId}}", toAccountId: "{{bkashId}}", amountMinor: taka(BKASH_TRANSFER.amount), feeMinor: taka(BKASH_TRANSFER.fee), txnDate: "2026-10-20", referenceNo: "TRF-2", description: "Top up bKash" },
      tests: postedTest,
    }),
  ]},
  { name: "3. A month of sales", item: saleRequests },
  { name: "4. A month of expenses", item: [signIn(), ...expenseRequests] },
  { name: "5. A refund and a mistake", item: [
    req(`Refund: ${money(REFUND.amount)}`, "POST", `${BIZ}/transactions`, {
      body: { postNow: true, type: "REFUND", accountId: ACCOUNT_IDS[REFUND.account], categoryId: "{{catSales}}", amountMinor: taka(REFUND.amount), txnDate: REFUND.date, description: REFUND.description },
      tests: postedTest,
    }),
    req(`A mistake: ${money(MISTAKE.amount)}`, "POST", `${BIZ}/transactions`, {
      body: { postNow: true, type: "EXPENSE", accountId: ACCOUNT_IDS[MISTAKE.account], categoryId: "{{catOtherExpenses}}", amountMinor: taka(MISTAKE.amount), txnDate: MISTAKE.date, description: MISTAKE.description },
      tests: [...postedTest, `pm.collectionVariables.set("mistakeId", pm.response.json().data.id);`],
    }),
    // Without a date, a reversal is dated today, which would leave the mistake in October's figures.
    req("Reverse the mistake, on the same date", "POST", `${BIZ}/transactions/{{mistakeId}}/reverse`, { body: { entryDate: MISTAKE.date, memo: "Wrong entry" }, tests: [status(200)] }),
  ]},
  { name: "6. Plans for next month", item: [
    signIn(),
    req("A task that's already late", "POST", `${BIZ}/tasks`, { body: { title: "ভ্যাট রিটার্ন জমা দিন", priority: "HIGH", dueAt: "2026-10-15T04:00:00.000Z" }, tests: [status(201)] }),
    req("A task for later", "POST", `${BIZ}/tasks`, { body: { title: "Renew trade license", dueAt: "2030-01-15T04:00:00.000Z" }, tests: [status(201)] }),
    req("A monthly reminder", "POST", `${BIZ}/reminders`, { body: { title: "দোকান ভাড়া দিন", startsAt: "2030-01-04T03:00:00.000Z", rrule: "FREQ=MONTHLY;BYMONTHDAY=4", leadMinutes: 1440 }, tests: [status(201)] }),
    req("A monthly salary schedule, starting today", "POST", `${BIZ}/recurring-schedules`, {
      pre: `pm.collectionVariables.set("today", new Date(Date.now() + 6 * 3600000).toISOString().slice(0, 10));`,
      body: { name: "কর্মীদের বেতন", kind: "SALARY", rrule: "FREQ=MONTHLY;BYMONTHDAY=-1", startDate: "{{today}}", accountId: "{{bankId}}", amountMinor: taka(65_000), remindDaysBefore: 3 },
      tests: [status(201)],
    }),
  ]},
  { name: "7. Import the bank statement (needs the worker)", item: [
    signIn(),
    req("A rule: bank charges categorize themselves", "POST", `${BIZ}/statement-rules`, {
      body: { name: "Bank charges", containsText: "service charge", direction: "OUT", categoryId: "{{catBankMFSCharges}}", autoPost: true },
      tests: [status(201)],
    }),
    req("Start the upload", "POST", `${BIZ}/documents/uploads`, {
      body: { type: "STATEMENT", fileName: "city-bank-october.csv", mime: "text/csv", sizeBytes: Buffer.byteLength(STATEMENT) },
      tests: [status(201), `const upload = pm.response.json().data;
pm.collectionVariables.set("statementUrl", upload.uploadUrl);
pm.collectionVariables.set("statementId", upload.document.id);`],
    }),
    req("Send the CSV file", "PUT", "{{statementUrl}}", { auth: false, raw: STATEMENT, contentType: "text/csv", tests: [status(200)] }),
    req("Finish the upload", "POST", `${BIZ}/documents/{{statementId}}/complete`, { tests: [status(200)] }),
    req("See its columns, and a suggested mapping", "POST", `${BIZ}/statement-imports/preview`, {
      body: { documentId: "{{statementId}}", financialAccountId: "{{bankId}}" },
      tests: [status(200), `pm.test("finds the heading row", () => pm.expect(pm.response.json().data.suggestion.headerRow).to.eql(3));`],
    }),
    req("Preview it with the mapping", "POST", `${BIZ}/statement-imports/preview`, {
      body: { documentId: "{{statementId}}", financialAccountId: "{{bankId}}", mapping: MAPPING },
      tests: [status(200), `const r = pm.response.json().data.result;
pm.test("reads every row, with balances that add up", () => { pm.expect(r.readableRows).to.eql(${bankRows.length}); pm.expect(r.failedRows).to.eql(0); pm.expect(r.balanceBreaks).to.eql(0); });`],
    }),
    req("Import it", "POST", `${BIZ}/statement-imports`, {
      body: { documentId: "{{statementId}}", financialAccountId: "{{bankId}}", mapping: MAPPING },
      tests: [status(202), `pm.collectionVariables.set("importId", pm.response.json().data.id);
pm.collectionVariables.set("importTries", "0");`],
    }),
    req("Wait for the worker to finish", "GET", `${BIZ}/statement-imports/{{importId}}`, {
      pre: `setTimeout(() => {}, 5000);`,
      tests: [status(200), `const row = pm.response.json().data;
const tries = Number(pm.collectionVariables.get("importTries")) + 1;
pm.collectionVariables.set("importTries", String(tries));
if (row.status !== "COMPLETED" && row.status !== "FAILED" && tries < 60) {
  postman.setNextRequest(pm.info.requestName);
} else {
  pm.test("finished. If this fails, start the worker: npm run worker", () => pm.expect(row.status).to.eql("COMPLETED"));
  pm.test("added every row", () => pm.expect(row.newLines).to.eql(${bankRows.length}));
}`],
    }),
    req("Only the unknown deposit should be left", "GET", `${BIZ}/statement-lines?status=UNMATCHED&financialAccountId={{bankId}}`, {
      tests: [status(200), `const items = pm.response.json().data.items;
pm.test("everything else matched itself", () => { pm.expect(items.length).to.eql(1); pm.expect(items[0].description).to.eql(${JSON.stringify(UNKNOWN_DEPOSIT.description)}); });
if (items[0]) pm.collectionVariables.set("unknownLineId", items[0].id);`],
    }),
    req("Say what the unknown deposit was", "POST", `${BIZ}/statement-lines/{{unknownLineId}}/categorize`, {
      body: { categoryId: "{{catOtherIncome}}", postNow: true, description: "Scrap sold, paid in at the branch" },
      tests: [status(200), `pm.test("settled", () => pm.expect(pm.response.json().data.status).to.eql("MATCHED"));`],
    }),
    req("Nothing is left in the inbox", "GET", `${BIZ}/statement-lines/summary?financialAccountId={{bankId}}`, {
      tests: [status(200), `pm.test("all settled", () => { const d = pm.response.json().data; pm.expect(d.unmatched).to.eql(0); pm.expect(d.matched).to.eql(${bankRows.length}); });`],
    }),
  ]},
  { name: "8. Reconcile the bank", item: [
    signIn(),
    req(`Start, with the statement's closing balance`, "POST", `${BIZ}/reconciliations`, {
      body: { financialAccountId: "{{bankId}}", statementDate: "2026-10-31", statementBalanceMinor: taka(bankEnd) },
      tests: [status(201), `pm.collectionVariables.set("recId", pm.response.json().data.id);`],
    }),
    req("Clear everything already matched", "POST", `${BIZ}/reconciliations/{{recId}}/apply-statement-matches`, {
      tests: [status(200), `pm.test("cleared them", () => pm.expect(pm.response.json().data.applied).to.be.greaterThan(${bankRows.length - 1}));`],
    }),
    req("What's left is the opening balance", "GET", `${BIZ}/reconciliations/{{recId}}`, {
      tests: [status(200), `const d = pm.response.json().data;
pm.test("the difference is the opening balance", () => pm.expect(d.differenceMinor).to.eql("${taka(OPENING.bank)}"));
pm.collectionVariables.set("openingLineId", d.unmatchedLines.find((line) => line.debitMinor === "${taka(OPENING.bank)}").id);`],
    }),
    req("Tick the opening balance", "POST", `${BIZ}/reconciliations/{{recId}}/lines`, {
      body: { journalLineIds: ["{{openingLineId}}"] },
      tests: [status(200), `pm.test("the books now match the bank", () => pm.expect(pm.response.json().data.differenceMinor).to.eql("0"));`],
    }),
    req("Close it", "POST", `${BIZ}/reconciliations/{{recId}}/close`, { body: {}, tests: [status(200)] }),
  ]},
  { name: "9. Read the results: these are the ones to look at", item: [
    signIn(),
    req("Profit & Loss for October", "GET", `${BIZ}/reports/profit-and-loss?from=2026-10-01&to=2026-10-31`, {
      tests: [status(200), `const d = pm.response.json().data;
pm.test("revenue", () => pm.expect(d.revenue.totalMinor).to.eql("${taka(revenue)}"));
pm.test("expenses, with the reversed mistake gone", () => pm.expect(d.expenses.totalMinor).to.eql("${taka(expenses)}"));
pm.test("net profit", () => pm.expect(d.netProfitMinor).to.eql("${taka(netProfit)}"));`],
    }),
    req("Balance Sheet on 31 October", "GET", `${BIZ}/reports/balance-sheet?asOf=2026-10-31`, {
      tests: [status(200), `const d = pm.response.json().data;
pm.test("it balances", () => pm.expect(d.balanced).to.eql(true));
pm.test("assets", () => pm.expect(d.assets.totalMinor).to.eql("${taka(totalCash)}"));`],
    }),
    req("Trial Balance on 31 October", "GET", `${BIZ}/reports/trial-balance?asOf=2026-10-31`, {
      tests: [status(200), `const d = pm.response.json().data;
pm.test("debits equal credits", () => pm.expect(d.totalDebitMinor).to.eql(d.totalCreditMinor));`],
    }),
    req("Cash Flow for October", "GET", `${BIZ}/reports/cash-flow?from=2026-10-01&to=2026-10-31`, {
      tests: [status(200), `const d = pm.response.json().data;
pm.test("it adds up", () => pm.expect(d.balanced).to.eql(true));
pm.test("ending cash", () => pm.expect(d.endingCashMinor).to.eql("${taka(totalCash)}"));`],
    }),
    req("Account balances", "GET", `${BIZ}/accounts`, {
      tests: [status(200), `const accounts = pm.response.json().data;
const balance = (name) => accounts.find((account) => account.name === name).currentBalanceMinor;
pm.test("City Bank", () => pm.expect(balance("City Bank")).to.eql("${taka(bankEnd)}"));
pm.test("bKash", () => pm.expect(balance("bKash Merchant")).to.eql("${taka(bkashEnd)}"));
pm.test("Cash", () => pm.expect(accounts.find((account) => account.type === "CASH").currentBalanceMinor).to.eql("${taka(cashEnd)}"));`],
    }),
    req("Dashboard", "GET", `${BIZ}/analytics/dashboard?fromMonth=2026-10&toMonth=2026-10`, {
      tests: [status(200), `const d = pm.response.json().data;
pm.test("agrees with the reports", () => { pm.expect(d.revenueMinor).to.eql("${taka(revenue)}"); pm.expect(d.netProfitMinor).to.eql("${taka(netProfit)}"); });`],
    }),
    req("Budget against actuals", "GET", `${BIZ}/budgets/{{budgetId}}`, {
      tests: [status(200), `const lines = pm.response.json().data.lines;
const spent = (name) => lines.find((line) => line.category.name === name).actualMinor;
pm.test("rent and marketing", () => { pm.expect(spent("Rent")).to.eql("${taka(rentSpent)}"); pm.expect(spent("Marketing")).to.eql("${taka(marketingSpent)}"); });`],
    }),
    req("Goal progress", "GET", `${BIZ}/goals/{{goalId}}`, { tests: [status(200)] }),
    req("All transactions", "GET", `${BIZ}/transactions?limit=100`, { tests: [status(200)] }),
    req("Journal entries", "GET", `${BIZ}/journals?limit=100`, { tests: [status(200)] }),
    req("Tasks: summary", "GET", `${BIZ}/tasks/summary`, { tests: [status(200), `pm.test("one overdue", () => pm.expect(pm.response.json().data.overdue).to.eql(1));`] }),
    req("What's coming up", "GET", `${BIZ}/tasks/calendar?from=2030-01-01&to=2030-01-31`, { tests: [status(200)] }),
    req("Your notifications (the worker makes these)", "GET", `${API}/notifications`, { tests: [status(200)] }),
    req("Request a Bangla PDF of the Profit & Loss", "POST", `${BIZ}/report-exports`, {
      body: { report: "PROFIT_AND_LOSS", format: "PDF", from: "2026-10-01", to: "2026-10-31", locale: "bn-BD" },
      tests: [status(202), `pm.collectionVariables.set("exportId", pm.response.json().data.id);
pm.collectionVariables.set("exportTries", "0");`],
    }),
    req("Wait for the PDF", "GET", `${BIZ}/report-exports/{{exportId}}`, {
      pre: `setTimeout(() => {}, 4000);`,
      tests: [status(200), `const row = pm.response.json().data;
const tries = Number(pm.collectionVariables.get("exportTries")) + 1;
pm.collectionVariables.set("exportTries", String(tries));
if (row.status !== "READY" && row.status !== "FAILED" && tries < 30) postman.setNextRequest(pm.info.requestName);
else pm.test("ready", () => pm.expect(row.status).to.eql("READY"));`],
    }),
    req("Get its download link: open it in a browser", "GET", `${BIZ}/report-exports/{{exportId}}/download`, { tests: [status(200)] }),
  ]},
  { name: "10. Ask the AI (needs AI_API_KEY)", item: [
    req("English: profit", "POST", `${API}/ai/chat`, {
      body: { message: "What was my net profit in October 2026?", businessId: "{{demoBusinessId}}" },
      pre: `setTimeout(() => {}, 1000);`,
      tests: [status(200, 503), `if (pm.response.code === 200) pm.test("says the true figure, ৳${netProfit.toLocaleString("en-IN")}", () => pm.expect(pm.response.json().data.content.replace(/,/g, "")).to.include("${netProfit.toFixed(2)}"));`],
    }),
    req("Bangla: biggest expense", "POST", `${API}/ai/chat`, {
      pre: `setTimeout(() => {}, 30000);`,
      body: { message: "অক্টোবর ২০২৬ এ কোন খাতে সবচেয়ে বেশি খরচ হয়েছে?", businessId: "{{demoBusinessId}}" },
      tests: [status(200, 503)],
    }),
    req("Bangla: bank balance", "POST", `${API}/ai/chat`, {
      pre: `setTimeout(() => {}, 30000);`,
      body: { message: "আমার ব্যাংকে এখন কত টাকা আছে?", businessId: "{{demoBusinessId}}" },
      tests: [status(200, 503)],
    }),
    req("Ask it to record something: it only suggests", "POST", `${API}/ai/chat`, {
      pre: `setTimeout(() => {}, 30000);`,
      body: { message: "Record a transport expense of 500 taka from cash on 31 October 2026.", businessId: "{{demoBusinessId}}" },
      tests: [status(200, 503)],
    }),
  ]},
];

fs.writeFileSync(out, JSON.stringify({
  info: {
    name: "Business OS: Demo Month (October 2026)",
    schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    description: "One realistic month for a small shop. Run the whole collection once, in order, with the API and worker running. Each run creates a new login and business. See README.md.",
  },
  variable: [
    { key: "baseUrl", value: "http://localhost:5001" },
    { key: "demoPassword", value: "demo-month-password" },
  ],
  item,
}, null, 2) + "\n");

process.stdout.write(`Revenue ${revenue}, expenses ${expenses}, net profit ${netProfit}. Bank ${bankEnd}, bKash ${bkashEnd}, Cash ${cashEnd}, total ${totalCash}\n`);
