import { Redis } from "ioredis";
import { env } from "../app/config/env.config.js";
import { logger } from "./logger.js";
import { redis } from "./redis.js";

// The worker makes notifications and the API holds the open browser connections, so the message
// crosses between the two processes through Redis.
type Listener = (message: string) => void;

const channelOf = (userId: string) => `notifications:${userId}`;

const listeners = new Map<string, Set<Listener>>();
let subscriber: Redis | null = null;

// A connection that has subscribed can do nothing else, so it can't be the shared one. It is only
// opened if a stream starts, so the worker never holds one.
const getSubscriber = () => {
  if (subscriber) return subscriber;

  subscriber = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  subscriber.on("error", (error) => logger.warn({ err: error }, "realtime connection error"));
  subscriber.on("message", (channel, message) => {
    for (const listener of listeners.get(channel) ?? []) listener(message);
  });
  return subscriber;
};

export const countStreams = (userId: string) => listeners.get(channelOf(userId))?.size ?? 0;

// Returns the function that stops listening.
export const subscribeToUser = (userId: string, listener: Listener) => {
  const channel = channelOf(userId);
  const existing = listeners.get(channel);
  if (existing) {
    existing.add(listener);
  } else {
    listeners.set(channel, new Set([listener]));
    void getSubscriber().subscribe(channel).catch((error) => logger.warn({ err: error }, "realtime subscribe failed"));
  }

  return () => {
    const current = listeners.get(channel);
    current?.delete(listener);
    if (current?.size === 0) {
      listeners.delete(channel);
      void getSubscriber().unsubscribe(channel).catch(() => {});
    }
  };
};

// Only a live update: the notification is already saved, so a miss shows on the next refresh.
export const publishToUser = (userId: string, message: object) =>
  redis.publish(channelOf(userId), JSON.stringify(message)).catch((error) => {
    logger.warn({ err: error }, "realtime publish failed");
  });

export const closeRealtime = () => {
  subscriber?.disconnect();
  subscriber = null;
  listeners.clear();
};
