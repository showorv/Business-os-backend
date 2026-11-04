// Run with `npm run ledger:verify`. Exits 1 if any entry is unbalanced, or if an account's cached
// balance or a monthly rollup differs from the ledger. Phase 6 moves this to a nightly job with an alert.
import { reportsService } from "../app/modules/reports/reports.service.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { redis } from "../lib/redis.js";

const businesses = await prisma.business.findMany({ select: { id: true } });
let problems = 0;

for (const { id } of businesses) {
  const check = await reportsService.verifyBusiness(id);
  const ok = check.unbalancedEntries === 0 && check.accountsOutOfStep === 0 && check.rollupsOutOfStep === 0;
  if (!ok) problems += 1;
  logger[ok ? "info" : "error"](check, ok ? "ledger ok" : "ledger PROBLEM");
}
logger.info({ businesses: businesses.length, problems }, "ledger verification finished");

await prisma.$disconnect();
redis.disconnect();
process.exitCode = problems > 0 ? 1 : 0;
