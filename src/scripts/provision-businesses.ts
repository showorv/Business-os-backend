// Run with `npm run db:provision`. Gives businesses created before a phase the starting data that
// phase added, such as the Cash account and categories. Safe to run any number of times.
import { businessesService } from "../app/modules/businesses/businesses.service.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { redis } from "../lib/redis.js";

const businesses = await prisma.business.findMany();

for (const business of businesses) {
  await prisma.$transaction((tx) => businessesService.provision(tx, business));
  logger.info({ business_id: business.id }, "business provisioned");
}
logger.info({ count: businesses.length }, "provisioning finished");

await prisma.$disconnect();
redis.disconnect();
