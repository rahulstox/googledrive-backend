import Redis from "ioredis";
import { cacheOps } from "./metrics.js";

let redisClient = null;
const isRedisEnabled = !!process.env.REDIS_URL;

if (isRedisEnabled) {
  redisClient = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => {
      if (times > 3) return null; // Stop retrying after 3 times
      return Math.min(times * 50, 2000);
    },
  });

  redisClient.on("error", (err) => {
    // Suppress connection errors to avoid log spam if Redis is flaky
    if (err.message.includes("ECONNREFUSED")) {
      // Silent or single log
    } else {
      console.error("[Cache] Redis error:", err.message);
    }
  });

  redisClient.on("connect", () => {
    console.log("[Cache] Redis connected");
  });
} else {
  console.log(
    "[Cache] Redis not configured (REDIS_URL missing). Caching disabled.",
  );
}

export const cache = {
  get: async (key) => {
    if (!redisClient) return null;
    try {
      const res = await redisClient.get(key);
      cacheOps.inc({ operation: "get", status: res ? "hit" : "miss" });
      return res;
    } catch (e) {
      cacheOps.inc({ operation: "get", status: "error" });
      return null;
    }
  },
  set: async (key, value, ttlSeconds = 60) => {
    if (!redisClient) return;
    try {
      await redisClient.set(key, value, "EX", ttlSeconds);
      cacheOps.inc({ operation: "set", status: "success" });
    } catch (e) {
      cacheOps.inc({ operation: "set", status: "error" });
      console.error("[Cache] Set error:", e.message);
    }
  },
  del: async (key) => {
    if (!redisClient) return;
    try {
      await redisClient.del(key);
      cacheOps.inc({ operation: "del", status: "success" });
    } catch (e) {
      cacheOps.inc({ operation: "del", status: "error" });
      console.error("[Cache] Del error:", e.message);
    }
  },
  isEnabled: () => !!redisClient && redisClient.status === "ready",
};
