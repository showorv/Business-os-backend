import type { Prisma } from "../../../lib/prisma.js";
import { prisma } from "../../../lib/prisma.js";
import { withRls } from "../../../lib/rls.js";
import { fromDbDate, toDbDate } from "../../utils/dates.js";
import { AppError, ErrorCode } from "../../utils/errors.js";
import type { RequestContext } from "../../utils/requestContext.js";
import { auditService } from "../audit/audit.service.js";
import type { AuthContext } from "../auth/auth.interface.js";
import type { IListRatesQuery, ISaveRateBody, ResolvedRate } from "./exchange-rates.interface.js";

const toDto = <T extends { rateDate: Date; rate: Prisma.Decimal }>(row: T) => ({
  ...row,
  rateDate: fromDbDate(row.rateDate),
  rate: row.rate.toFixed(6),
});

const scopeOf = (auth: AuthContext) => ({ userId: auth.userId, workspaceId: auth.workspaceId, businessIds: [] });

// Rates belong to your own workspace. Saving the same pair and date again corrects it.
// Uses the normal connection, because its audit row belongs to a workspace rather than a business,
// which the restricted role can't write. Every query names the workspace explicitly.
const save = async (auth: AuthContext, body: ISaveRateBody, context: RequestContext) => {
  const row = await prisma.$transaction(async (tx) => {
    const key = {
      workspaceId: auth.workspaceId,
      fromCurrency: body.fromCurrency,
      toCurrency: body.toCurrency,
      rateDate: toDbDate(body.rateDate),
    };
    const saved = await tx.exchangeRate.upsert({
      where: { workspaceId_fromCurrency_toCurrency_rateDate: key },
      create: { ...key, rate: body.rate, createdBy: auth.userId },
      update: { rate: body.rate },
    });
    await auditService.record(tx, {
      action: "exchange_rate.saved",
      context,
      workspaceId: auth.workspaceId,
      actorUserId: auth.userId,
      after: { ...body },
    });
    return saved;
  });
  return toDto(row);
};

const list = async (auth: AuthContext, query: IListRatesQuery) => {
  const rows = await withRls(scopeOf(auth), (tx) =>
    tx.exchangeRate.findMany({
      where: {
        workspaceId: auth.workspaceId,
        ...(query.fromCurrency ? { fromCurrency: query.fromCurrency } : {}),
        ...(query.toCurrency ? { toCurrency: query.toCurrency } : {}),
      },
      orderBy: [{ rateDate: "desc" }, { id: "desc" }],
      take: 500,
    }),
  );
  return rows.map(toDto);
};

// The latest rate on or before the date, stored in either direction.
const resolve = async (
  tx: Prisma.TransactionClient,
  workspaceId: string,
  fromCurrency: string,
  toCurrency: string,
  onDate: string,
): Promise<ResolvedRate> => {
  if (fromCurrency === toCurrency) return { rate: "1", rateDate: null, inverted: false };

  const latest = (from: string, to: string) =>
    tx.exchangeRate.findFirst({
      where: { workspaceId, fromCurrency: from, toCurrency: to, rateDate: { lte: toDbDate(onDate) } },
      orderBy: { rateDate: "desc" },
    });

  const direct = await latest(fromCurrency, toCurrency);
  if (direct) return { rate: direct.rate.toFixed(6), rateDate: fromDbDate(direct.rateDate), inverted: false };

  const reverse = await latest(toCurrency, fromCurrency);
  if (reverse) return { rate: reverse.rate.toFixed(6), rateDate: fromDbDate(reverse.rateDate), inverted: true };

  throw new AppError(422, ErrorCode.FX_RATE_MISSING, { fromCurrency, toCurrency, onDate });
};

export const exchangeRatesService = { save, list, resolve };
