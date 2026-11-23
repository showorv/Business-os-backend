import type { z } from "zod";
import type { platformValidation } from "./platform.validation.js";

export type AnnouncementTone = "info" | "warning";

// Everything the platform admin can change without code. Missing values use DEFAULT_SETTINGS.
export interface PlatformSettings {
  // New sign-ups try this plan for this many days. 0 days: they start on Free.
  trialDays: number;
  trialPlanKey: string;
  // How long a paid plan keeps working after it ends.
  graceDays: number;
  // Switches the AI assistant off for everyone, whatever their plan.
  aiEnabled: boolean;
  // Closes sign-ups, except for someone with a pending invitation.
  signupsEnabled: boolean;
  // A message shown at the top of the app for everyone signed in.
  announcement: { active: boolean; tone: AnnouncementTone; en: string; bn: string };
  // Paying by hand: the customer sends money by bKash, Nagad, Rocket or bank, says so in the app, and the
  // admin checks and approves it. Always on while there's no online gateway; `enabled` offers it next to one.
  manualPayments: ManualPayments;
}

export type ManualMethod = "bkash" | "nagad" | "rocket" | "bank";

export interface ManualPayments {
  enabled: boolean;
  // Where to send the money, in the order shown. `details` is free text: "01712-345678 (Personal)", or a bank's
  // name, branch and account.
  methods: { method: ManualMethod; details: string }[];
  // How to reach the admin with questions. Empty ones aren't shown.
  whatsapp: string;
  phone: string;
  email: string;
  // A line of extra instructions, such as office hours.
  noteEn: string;
  noteBn: string;
}

export type IUpdateSettingsBody = z.infer<typeof platformValidation.updateSettings>;
