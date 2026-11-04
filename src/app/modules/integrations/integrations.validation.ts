import { z } from "zod";
import { paginationQuery } from "../../utils/pagination.js";

const connectionParams = z.object({ connectionId: z.uuid() });

// Each provider checks its own secrets with a strict schema, so a password or PIN sent here is refused.
const secrets = z.record(z.string(), z.string().max(2000));
const syncEveryHours = z.number().int().min(1).max(24 * 7);

const create = z.object({
  provider: z.string().min(1).max(50),
  financialAccountId: z.uuid(),
  secrets,
  syncEveryHours: syncEveryHours.default(6),
});

const update = z
  .object({ status: z.enum(["ACTIVE", "DISABLED"]), syncEveryHours })
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: "NO_FIELDS_TO_UPDATE" });

const reauthorize = z.object({ secrets });

const runsQuery = z.object({ ...paginationQuery });

export const integrationsValidation = { connectionParams, create, update, reauthorize, runsQuery };
