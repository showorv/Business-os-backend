import type { Prisma } from "../../../lib/prisma.js";
import { prisma } from "../../../lib/prisma.js";
import type { PlatformSettings } from "./platform.interface.js";

export const DEFAULT_SETTINGS: PlatformSettings = {
  trialDays: 14,
  trialPlanKey: "pro",
  graceDays: 7,
  aiEnabled: true,
  signupsEnabled: true,
  announcement: { active: false, tone: "info", en: "", bn: "" },
};

// Read on almost every request, changed rarely. Each process keeps a copy for a few seconds; a change
// made here clears it at once, and other processes (the worker) see it within CACHE_MS.
const CACHE_MS = 10_000;
let cached: { value: PlatformSettings; at: number } | null = null;

const settings = async (): Promise<PlatformSettings> => {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const rows = await prisma.platformSetting.findMany();
  const stored = Object.fromEntries(rows.map((row) => [row.key, row.value])) as Partial<PlatformSettings>;
  const value: PlatformSettings = {
    ...DEFAULT_SETTINGS,
    ...stored,
    announcement: { ...DEFAULT_SETTINGS.announcement, ...(stored.announcement ?? {}) },
  };
  cached = { value, at: Date.now() };
  return value;
};

// Saves only the keys sent. Returns the settings before and after, for the audit log.
const update = async (tx: Prisma.TransactionClient, changes: Partial<PlatformSettings>, userId: string) => {
  const before = await settings();
  for (const [key, value] of Object.entries(changes)) {
    await tx.platformSetting.upsert({
      where: { key },
      create: { key, value: value as Prisma.InputJsonValue, updatedBy: userId },
      update: { value: value as Prisma.InputJsonValue, updatedBy: userId },
    });
  }
  cached = null;
  return before;
};

const forgetCache = () => {
  cached = null;
};

// The banner everyone signed in sees, or null.
const announcement = async () => {
  const { announcement } = await settings();
  return announcement.active ? { tone: announcement.tone, en: announcement.en, bn: announcement.bn || announcement.en } : null;
};

// What the public home and pricing pages say about signing up: the free trial, and whether sign-ups are open.
const signup = async () => {
  const { trialDays, trialPlanKey, signupsEnabled } = await settings();
  return { trialDays, trialPlanKey, signupsEnabled };
};

export const platformService = { settings, update, forgetCache, announcement, signup };
