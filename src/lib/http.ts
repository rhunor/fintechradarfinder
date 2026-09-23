/**
 * http.ts — one shared HTTP connection pool for all outbound fetches.
 *
 * WHY THIS EXISTS: Node's built-in fetch closes idle sockets after 4 seconds.
 * Our cycles run 60 seconds apart, so by default EVERY cycle paid a fresh TLS
 * handshake for every due source — around a dozen handshakes a minute, forever.
 * TLS key exchange is genuine processor work, and Active CPU is the Hobby meter
 * with the least headroom (4 hours a month).
 *
 * Raising keepAliveTimeout past the cycle interval lets a warm Vercel container
 * reuse its connections across cycles. Vercel keeps containers warm for far
 * longer than a minute when invoked every minute, so in steady state most
 * cycles should do no handshakes at all.
 *
 * This must be imported before any fetch happens, so the poll route pulls it in
 * at module scope.
 */

import { Agent, setGlobalDispatcher } from "undici";

/** Guard so repeated imports on a warm container do not rebuild the pool. */
declare global {
  var __fdrDispatcherReady: boolean | undefined;
}

if (!globalThis.__fdrDispatcherReady) {
  setGlobalDispatcher(
    new Agent({
      // Longer than the 60s cycle interval, so sockets survive between cycles.
      keepAliveTimeout: 90_000,
      // Hard ceiling regardless of what a server advertises.
      keepAliveMaxTimeout: 120_000,
      // We fetch at most two requests per host concurrently (see fetch-all),
      // so a small pool per origin is plenty.
      connections: 4,
      // Fail fast on a dead connection rather than hanging the cycle.
      connectTimeout: 5_000,
      // Feeds are small; cap headers so a hostile response cannot balloon memory.
      maxHeaderSize: 16_384,
    }),
  );
  globalThis.__fdrDispatcherReady = true;
}

/** Imported for its side effect; exported so the import is never tree-shaken. */
export const httpReady = true;
