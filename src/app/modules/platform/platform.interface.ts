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
}

export type IUpdateSettingsBody = z.infer<typeof platformValidation.updateSettings>;
