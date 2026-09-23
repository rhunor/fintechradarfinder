/**
 * telegram-updates.ts — makes retried Telegram updates safe to replay.
 *
 * WHY: Telegram redelivers an update if our webhook is slow or returns an
 * error, and it does not care that we already acted on it. Without a guard,
 * one slow response to "/pause" could pause, unpause, and pause again as the
 * same update arrives three times.
 *
 * The guard is an insert against a unique _id (Telegram's update_id). Exactly
 * one insert can succeed, so exactly one handler run happens. A TTL index drops
 * the records after a day, which is far longer than Telegram's retry window.
 */

import type { Db } from "mongodb";
import { COLLECTIONS, type TelegramUpdateDoc } from "@/lib/store/schema";

const DUPLICATE_KEY = 11000;

/**
 * Returns true if this update_id has not been handled before.
 *
 * Claiming BEFORE doing the work, rather than marking afterwards, is what makes
 * this correct: a retry arriving while the first run is still in flight must be
 * rejected too.
 */
export async function claimUpdate(db: Db, updateId: number): Promise<boolean> {
  try {
    await db
      .collection<TelegramUpdateDoc>(COLLECTIONS.telegramUpdates)
      .insertOne({ _id: updateId, receivedAt: new Date() });
    return true;
  } catch (err) {
    if ((err as { code?: number }).code === DUPLICATE_KEY) return false;
    // A database problem must not silently swallow a command, so let it run.
    // Acting twice on a rare error is better than never acting at all.
    throw err;
  }
}
