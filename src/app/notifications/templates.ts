import { env } from "../config/env.config.js";
import type { NotificationParams, NotificationType } from "../modules/notifications/notifications.interface.js";
import { formatDate, formatDateTime } from "../utils/dates.js";
import { formatMoney } from "../utils/money.js";

// The words for email and push. The in-app list sends only the type and values, and the frontend
// words them, so this is the one place the backend writes sentences.
export type Locale = "en" | "bn-BD";

export interface RenderOptions {
  locale: Locale;
  digitStyle: "latin" | "bangla";
  grouping: "lakh" | "western";
  businessName: string | null;
  businessId: string | null;
}

interface Words {
  subject: string;
  body: string;
}

interface Template {
  en: Words;
  bn: Words;
  // Where the button goes in the web app, inside the business's pages (/b/{businessId}).
  path?: string;
  // The path is a whole-app page, not inside one business.
  global?: true;
}

// Turns stored values into text in the reader's language and digits.
const formattersFor = (params: NotificationParams, options: RenderOptions) => ({
  text: (key: string) => String(params[key] ?? ""),
  money: (key: string) =>
    formatMoney(BigInt(String(params[key] ?? 0)), String(params.currency ?? "BDT"), { digitStyle: options.digitStyle, grouping: options.grouping }),
  moment: (key: string) =>
    params[key]
      ? formatDateTime(new Date(String(params[key])), options.locale, options.digitStyle, String(params.timezone ?? "Asia/Dhaka"))
      : "",
  date: (key: string) => (params[key] ? formatDate(String(params[key]), options.locale, options.digitStyle) : ""),
  count: (key: string) => {
    const value = String(params[key] ?? "");
    return options.digitStyle === "bangla" ? value.replace(/\d/g, (digit) => String.fromCharCode(0x09e6 + Number(digit))) : value;
  },
});

type Formatters = ReturnType<typeof formattersFor>;

const TEMPLATES: Record<NotificationType, (f: Formatters) => Template> = {
  "task.assigned": (f) => ({
    en: { subject: `New task: ${f.text("title")}`, body: `You have been assigned "${f.text("title")}".` },
    bn: { subject: `নতুন কাজ: ${f.text("title")}`, body: `আপনাকে "${f.text("title")}" কাজটি দেওয়া হয়েছে।` },
    path: `/tasks?task=${f.text("taskId")}`,
  }),
  "task.commented": (f) => ({
    en: { subject: `New comment on: ${f.text("title")}`, body: `${f.text("authorName")} commented on "${f.text("title")}".` },
    bn: { subject: `নতুন মন্তব্য: ${f.text("title")}`, body: `${f.text("authorName")} "${f.text("title")}" কাজে মন্তব্য করেছেন।` },
    path: `/tasks?task=${f.text("taskId")}`,
  }),
  "task.overdue": (f) => ({
    en: { subject: `Overdue: ${f.text("title")}`, body: `"${f.text("title")}" was due on ${f.moment("dueAt")}.` },
    bn: { subject: `সময় পেরিয়ে গেছে: ${f.text("title")}`, body: `"${f.text("title")}" কাজের শেষ সময় ছিল ${f.moment("dueAt")}।` },
    path: `/tasks?task=${f.text("taskId")}`,
  }),
  "reminder.due": (f) => ({
    en: { subject: `Reminder: ${f.text("title")}`, body: `"${f.text("title")}" is due on ${f.moment("occurrenceAt")}.` },
    bn: { subject: `অনুস্মারক: ${f.text("title")}`, body: `"${f.text("title")}" এর সময়: ${f.moment("occurrenceAt")}।` },
    path: "/tasks?tab=reminders",
  }),
  "transaction.pending_approval": (f) => ({
    en: { subject: `Approval needed: ${f.text("number")}`, body: `Transaction ${f.text("number")} for ${f.money("amountMinor")} is waiting for your approval.` },
    bn: { subject: `অনুমোদন দরকার: ${f.text("number")}`, body: `${f.money("amountMinor")} পরিমাণের লেনদেন ${f.text("number")} আপনার অনুমোদনের অপেক্ষায় আছে।` },
    path: `/transactions/${f.text("transactionId")}`,
  }),
  "budget.threshold": (f) => ({
    en: {
      subject: `Budget alert: ${f.text("categoryName")} reached ${f.count("percent")}%`,
      body: `${f.text("categoryName")} in the budget "${f.text("budgetName")}" has used ${f.money("actualMinor")} of ${f.money("amountMinor")}.`,
    },
    bn: {
      subject: `বাজেট সতর্কতা: ${f.text("categoryName")} ${f.count("percent")}% ছুঁয়েছে`,
      body: `"${f.text("budgetName")}" বাজেটে ${f.text("categoryName")} খাতে ${f.money("amountMinor")} এর মধ্যে ${f.money("actualMinor")} খরচ হয়েছে।`,
    },
    path: `/budgets/${f.text("budgetId")}`,
  }),
  "goal.achieved": (f) => ({
    en: { subject: `Goal achieved: ${f.text("goalName")}`, body: `You reached your goal "${f.text("goalName")}".` },
    bn: { subject: `লক্ষ্য পূরণ হয়েছে: ${f.text("goalName")}`, body: `আপনি "${f.text("goalName")}" লক্ষ্য পূরণ করেছেন।` },
    path: "/goals",
  }),
  "export.ready": (f) => ({
    en: { subject: "Your report is ready", body: `Your ${f.text("format")} export is ready to download.` },
    bn: { subject: "আপনার রিপোর্ট তৈরি", body: `আপনার ${f.text("format")} রিপোর্ট ডাউনলোডের জন্য তৈরি।` },
    path: "/reports",
  }),
  "export.failed": (f) => ({
    en: { subject: "Your report could not be made", body: `Your ${f.text("format")} export failed. Please try again.` },
    bn: { subject: "রিপোর্ট তৈরি করা যায়নি", body: `আপনার ${f.text("format")} রিপোর্ট তৈরি হয়নি। আবার চেষ্টা করুন।` },
    path: "/reports",
  }),
  "recurring.failed": (f) => ({
    en: {
      subject: `Recurring transaction failed: ${f.text("scheduleName")}`,
      body: `"${f.text("scheduleName")}" could not run for ${f.date("occurrenceDate")} (${f.text("errorCode")}). Nothing was recorded for that date.`,
    },
    bn: {
      subject: `নিয়মিত লেনদেন ব্যর্থ: ${f.text("scheduleName")}`,
      body: `${f.date("occurrenceDate")} তারিখে "${f.text("scheduleName")}" চালানো যায়নি (${f.text("errorCode")})। ওই তারিখের জন্য কিছু লেখা হয়নি।`,
    },
    path: `/recurring?schedule=${f.text("scheduleId")}`,
  }),
  "ledger.check_failed": () => ({
    en: { subject: "Your books need checking", body: "The nightly check found figures that don't match the ledger. Please look into this before relying on your reports." },
    bn: { subject: "আপনার হিসাব পরীক্ষা করা দরকার", body: "রাতের পরীক্ষায় কিছু অঙ্ক লেজারের সাথে মেলেনি। রিপোর্টের উপর নির্ভর করার আগে এটি দেখে নিন।" },
  }),
  "audit.check_failed": () => ({
    en: { subject: "Audit log check failed", body: "The nightly check found that the audit log may have been changed. Please look into this now." },
    bn: { subject: "অডিট লগ পরীক্ষা ব্যর্থ", body: "রাতের পরীক্ষায় দেখা গেছে অডিট লগ বদলানো হয়ে থাকতে পারে। এখনই এটি দেখে নিন।" },
  }),
  "statement_import.finished": (f) => ({
    en: { subject: "Your statement was imported", body: `${f.count("newLines")} new lines were added, and ${f.count("needsReview")} need your review.` },
    bn: { subject: "আপনার স্টেটমেন্ট ইমপোর্ট হয়েছে", body: `${f.count("newLines")}টি নতুন লাইন যোগ হয়েছে, এবং ${f.count("needsReview")}টি আপনার দেখা দরকার।` },
    path: "/statements",
  }),
  "integration.needs_reauth": (f) => ({
    en: { subject: `Reconnect ${f.text("provider")}`, body: `${f.text("provider")} stopped accepting our sign-in, so syncing has paused. Please enter its credentials again.` },
    bn: { subject: `${f.text("provider")} আবার সংযুক্ত করুন`, body: `${f.text("provider")} আমাদের সাইন ইন নিচ্ছে না, তাই সিঙ্ক বন্ধ আছে। দয়া করে আবার তথ্য দিন।` },
    path: "/statements",
  }),
  "integration.sync_failing": (f) => ({
    en: { subject: `${f.text("provider")} keeps failing to sync`, body: `${f.count("failures")} syncs in a row have failed. Statement lines may be out of date.` },
    bn: { subject: `${f.text("provider")} সিঙ্ক বারবার ব্যর্থ`, body: `পরপর ${f.count("failures")}টি সিঙ্ক ব্যর্থ হয়েছে। স্টেটমেন্টের তথ্য পুরনো হতে পারে।` },
    path: "/statements",
  }),
  invitation: (f) => ({
    en: { subject: `You're invited to ${f.text("businessName")}`, body: `${f.text("inviterName")} invited you to join ${f.text("businessName")}. This link lasts 7 days.` },
    bn: { subject: `${f.text("businessName")} এ আমন্ত্রণ`, body: `${f.text("inviterName")} আপনাকে ${f.text("businessName")} এ যোগ দিতে আমন্ত্রণ জানিয়েছেন। এই লিংক ৭ দিন কাজ করবে।` },
    path: `/invitations/accept?token=${encodeURIComponent(f.text("token"))}`,
    global: true,
  }),
  "auth.password_reset": (f) => ({
    en: { subject: "Reset your password", body: "Use this link to choose a new password. It lasts one hour. If you didn't ask for this, you can ignore this email." },
    bn: { subject: "পাসওয়ার্ড রিসেট করুন", body: "নতুন পাসওয়ার্ড বেছে নিতে এই লিংক ব্যবহার করুন। এটি এক ঘণ্টা কাজ করবে। আপনি না চাইলে এই ইমেইল উপেক্ষা করুন।" },
    path: `/reset-password?token=${encodeURIComponent(f.text("token"))}`,
    global: true,
  }),
  "auth.password_changed": () => ({
    en: { subject: "Your password was changed", body: "Your password was just changed and you were signed out everywhere. If this wasn't you, reset your password now." },
    bn: { subject: "আপনার পাসওয়ার্ড বদলানো হয়েছে", body: "আপনার পাসওয়ার্ড এইমাত্র বদলানো হয়েছে এবং সব জায়গা থেকে সাইন আউট হয়েছে। এটি আপনি না করলে এখনই পাসওয়ার্ড রিসেট করুন।" },
  }),
  "auth.account_locked": () => ({
    en: { subject: "Your account was locked for 15 minutes", body: "Too many sign-in attempts failed. If this wasn't you, consider changing your password." },
    bn: { subject: "আপনার অ্যাকাউন্ট ১৫ মিনিটের জন্য বন্ধ", body: "অনেকবার সাইন ইন ব্যর্থ হয়েছে। এটি আপনি না হলে পাসওয়ার্ড বদলানোর কথা ভাবুন।" },
  }),
  "auth.session_reuse_detected": () => ({
    en: { subject: "Suspicious sign-in activity", body: "An old session token was used again, which can mean it was stolen. We signed that session out. Please check your active sessions." },
    bn: { subject: "সন্দেহজনক সাইন ইন", body: "একটি পুরনো সেশন টোকেন আবার ব্যবহার হয়েছে, যার মানে এটি চুরি হয়ে থাকতে পারে। সেই সেশন বন্ধ করা হয়েছে। আপনার সক্রিয় সেশনগুলো দেখে নিন।" },
  }),
};

const BUTTON_LABEL: Record<Locale, string> = { en: "Open Business OS", "bn-BD": "Business OS খুলুন" };
const BUSINESS_LABEL: Record<Locale, string> = { en: "Business", "bn-BD": "ব্যবসা" };

// Titles and names are typed by users, so they must never reach an email as HTML.
const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export const renderNotification = (type: NotificationType, params: NotificationParams, options: RenderOptions) => {
  const template = TEMPLATES[type](formattersFor(params, options));
  const words = options.locale === "bn-BD" ? template.bn : template.en;
  // Business pages live under /b/{businessId} in the web app; without a business there's nowhere to send them.
  const path = template.path && (template.global ? template.path : options.businessId ? `/b/${options.businessId}${template.path}` : null);
  const url = path ? `${env.APP_URL}${path}` : null;
  const business = options.businessName ? `${BUSINESS_LABEL[options.locale]}: ${options.businessName}` : null;

  const text = [words.body, business, url].filter(Boolean).join("\n\n");
  const html = `<!doctype html>
<html lang="${options.locale}"><body style="font-family:'Noto Sans Bengali',Arial,sans-serif;color:#1f2937;line-height:1.6;max-width:560px;margin:0 auto;padding:24px">
<h2 style="font-size:18px;margin:0 0 12px">${escapeHtml(words.subject)}</h2>
<p style="margin:0 0 16px">${escapeHtml(words.body)}</p>
${business ? `<p style="margin:0 0 16px;color:#6b7280;font-size:14px">${escapeHtml(business)}</p>` : ""}
${url ? `<p style="margin:0"><a href="${escapeHtml(url)}" style="display:inline-block;background:#166534;color:#ffffff;padding:10px 18px;border-radius:6px;text-decoration:none">${BUTTON_LABEL[options.locale]}</a></p>` : ""}
</body></html>`;

  return { subject: words.subject, text, html, url };
};
