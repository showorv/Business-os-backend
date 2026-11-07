import { z } from "zod";

const updateSettings = z
  .object({
    trialDays: z.number().int().min(0).max(365),
    trialPlanKey: z.string().trim().min(1).max(40),
    graceDays: z.number().int().min(0).max(60),
    aiEnabled: z.boolean(),
    signupsEnabled: z.boolean(),
    announcement: z.object({
      active: z.boolean(),
      tone: z.enum(["info", "warning"]),
      en: z.string().trim().max(500),
      bn: z.string().trim().max(500),
    }),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: "Send at least one setting" })
  // An announcement that's switched on needs words in English.
  .refine((body) => !body.announcement?.active || body.announcement.en.length > 0, { message: "An active announcement needs English text", path: ["announcement", "en"] });

export const platformValidation = { updateSettings };
