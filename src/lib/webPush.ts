import webPush from "web-push";
import { env } from "../app/config/env.config.js";

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

const MESSAGE_TTL_SECONDS = 24 * 60 * 60;

export const pushEnabled = () => Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);

export const pushPublicKey = () => env.VAPID_PUBLIC_KEY ?? null;

// Returns false when the browser has unsubscribed, so the caller can forget it.
export const sendPush = async (target: PushTarget, payload: object) => {
  try {
    await webPush.sendNotification(
      { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
      JSON.stringify(payload),
      {
        TTL: MESSAGE_TTL_SECONDS,
        vapidDetails: { subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY!, privateKey: env.VAPID_PRIVATE_KEY! },
      },
    );
    return true;
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 404 || status === 410) return false;
    throw error;
  }
};
