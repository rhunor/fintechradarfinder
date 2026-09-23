/**
 * client.ts — one cached MongoDB connection per warm serverless container.
 *
 * WHY THIS MATTERS ON A FREE TIER: Atlas M0 allows only 500 concurrent
 * connections, and Vercel may keep many function containers warm at once. If
 * every invocation opened a fresh pool we would exhaust M0 within minutes and
 * every cycle would start failing.
 *
 * So the client is cached on `globalThis`, which survives between warm
 * invocations of the same container (module scope alone is not reliable across
 * Next.js's dev-mode module reloading, hence globalThis). maxPoolSize is 5:
 * one cycle never runs more than a handful of queries concurrently, and a small
 * pool keeps our total connection count low even with many warm containers.
 *
 * We deliberately never call client.close(). Closing would throw away the pool
 * that makes the next warm invocation cheap, and the driver handles idle
 * sockets on its own.
 */

import { MongoClient, type Db } from "mongodb";
import { env } from "@/lib/env";

/** Shape of the cache we hang off globalThis. */
interface MongoCache {
  client: MongoClient | null;
  promise: Promise<MongoClient> | null;
}

// `var` is required here: globalThis augmentation does not work with let/const.
declare global {
  var __fdrMongo: MongoCache | undefined;
}

const cache: MongoCache = globalThis.__fdrMongo ?? { client: null, promise: null };
globalThis.__fdrMongo = cache;

export async function getClient(): Promise<MongoClient> {
  if (cache.client) return cache.client;

  // Several concurrent callers on a cold container must share one connect(),
  // not race to open five pools. Caching the promise, not just the client, is
  // what makes that safe.
  if (!cache.promise) {
    const client = new MongoClient(env.mongodbUri, {
      maxPoolSize: 5,
      minPoolSize: 0,
      // Fail rather than hang, but allow for a genuinely cold connect: an
      // mongodb+srv connection does a DNS SRV lookup, a TLS handshake and
      // replica-set discovery before it is usable, which measured over 5s from
      // a cold start. 5s produced real server-selection timeouts; 8s still
      // leaves most of the cycle budget intact if the cluster is unreachable.
      serverSelectionTimeoutMS: env.mongodbServerSelectionTimeoutMs,
      connectTimeoutMS: env.mongodbServerSelectionTimeoutMs,
      socketTimeoutMS: 15_000,
      // Retry once on transient network blips, which are common on shared tiers.
      retryWrites: true,
      retryReads: true,
      appName: "fintech-deal-radar",
    });
    cache.promise = client.connect().catch((err: unknown) => {
      // Clear the cached promise so the next invocation can retry instead of
      // forever awaiting a rejected connect.
      cache.promise = null;
      throw err;
    });
  }

  cache.client = await cache.promise;
  return cache.client;
}

export async function getDb(): Promise<Db> {
  const client = await getClient();
  return client.db(env.mongodbDb);
}

/**
 * Closes the pool and clears the cache. Only for one-shot CLI scripts and
 * tests, which must not leave the process hanging on an open socket.
 *
 * Serverless code must never call this: the whole point of the cache is that
 * the next warm invocation reuses the pool. Clearing the cache here (rather
 * than only closing) matters because a cached-but-closed client would make
 * every later call fail with MongoNotConnectedError.
 */
export async function closeClient(): Promise<void> {
  const client = cache.client;
  cache.client = null;
  cache.promise = null;
  if (client) await client.close();
}
