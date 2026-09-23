/**
 * /api/cron/poll — runs exactly one poll cycle.
 *
 * Called once a minute by an external scheduler (cron-job.org), because Vercel
 * Hobby only allows DAILY cron jobs.
 *
 * WHY IT REPLIES BEFORE DOING THE WORK: schedulers use short HTTP timeouts,
 * often 30 seconds or less, and treat a slow response as a failure worth
 * retrying — which would stack cycles on top of each other. So we validate the
 * secret, return 202 immediately, and run the cycle inside Next.js's `after()`,
 * which keeps the function alive after the response has been flushed.
 *
 * The lease inside runCycle() is what makes a retried or overlapping call safe.
 */

import { after } from "next/server";
import { getDb } from "@/lib/store/client";
import { runCycle } from "@/lib/pipeline/cycle";
import { isAuthorized, unauthorized } from "@/lib/auth";
import { log, errorInfo, setLogContext, clearLogContext } from "@/lib/log";
import { randomUUID } from "node:crypto";

// The MongoDB driver is Node-only; this must never run on the Edge runtime.
export const runtime = "nodejs";
// Never cache a route whose whole purpose is a side effect.
export const dynamic = "force-dynamic";
// Hobby allows up to 60s. The cycle's own budget stops well short of this.
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  if (!isAuthorized(request)) {
    log.warn("cron.poll.unauthorized");
    return unauthorized();
  }

  const cycleId = randomUUID().slice(0, 8);

  // Everything below runs AFTER the response is sent.
  after(async () => {
    setLogContext({ cycle_id: cycleId });
    try {
      const db = await getDb();
      await runCycle(db);
    } catch (err) {
      log.error("cron.poll.failed", errorInfo(err));
    } finally {
      clearLogContext();
    }
  });

  return Response.json({ accepted: true, cycle_id: cycleId }, { status: 202 });
}
