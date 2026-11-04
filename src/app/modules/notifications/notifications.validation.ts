import { z } from "zod";
import { paginationQuery } from "../../utils/pagination.js";
import { timezoneField } from "../../utils/validationFields.js";

const notificationParams = z.object({ notificationId: z.uuid() });
const subscriptionParams = z.object({ subscriptionId: z.uuid() });

const listQuery = z.object({
  ...paginationQuery,
  unreadOnly: z.stringbool().default(false),
});

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const updatePreferences = z
  .object({
    emailEnabled: z.boolean(),
    pushEnabled: z.boolean(),
    quietHoursStart: timeOfDay.nullable(),
    quietHoursEnd: timeOfDay.nullable(),
    timezone: timezoneField,
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: "NO_FIELDS_TO_UPDATE" })
  // Quiet hours are a pair: both set, or both cleared.
  .refine((body) => (body.quietHoursStart === undefined) === (body.quietHoursEnd === undefined), { message: "QUIET_HOURS_NEED_BOTH" })
  .refine((body) => (body.quietHoursStart === null) === (body.quietHoursEnd === null), { message: "QUIET_HOURS_NEED_BOTH" });

// The worker sends a request to whatever address is saved here, so it must really be a browser's
// push service. Otherwise this could be used to make the server call its own internal network.
const PUSH_SERVICE_HOSTS = [/^fcm\.googleapis\.com$/, /\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/, /\.push\.apple\.com$/];

const isPushServiceUrl = (value: string) => {
  const url = new URL(value);
  return url.protocol === "https:" && PUSH_SERVICE_HOSTS.some((host) => host.test(url.hostname));
};

// The same shape a browser's PushSubscription.toJSON() produces.
const pushSubscribe = z.object({
  endpoint: z.url().max(1000).refine(isPushServiceUrl, { message: "UNSUPPORTED_PUSH_SERVICE" }),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
});

export const notificationsValidation = { notificationParams, subscriptionParams, listQuery, updatePreferences, pushSubscribe };
