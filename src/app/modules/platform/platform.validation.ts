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
    manualPayments: z.object({
      enabled: z.boolean(),
      methods: z
        .array(z.object({ method: z.enum(["bkash", "nagad", "rocket", "bank"]), details: z.string().trim().min(3).max(300) }))
        .max(8),
      whatsapp: z.string().trim().max(30),
      phone: z.string().trim().max(30),
      email: z.union([z.literal(""), z.email().max(200)]),
      noteEn: z.string().trim().max(500),
      noteBn: z.string().trim().max(500),
    }),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: "Send at least one setting" })
  // An announcement that's switched on needs words in English.
  .refine((body) => !body.announcement?.active || body.announcement.en.length > 0, { message: "An active announcement needs English text", path: ["announcement", "en"] });

export const platformValidation = { updateSettings };
