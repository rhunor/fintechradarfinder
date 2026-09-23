/**
 * setup.ts — loads .env.local so database-backed tests can find MONGODB_URI.
 *
 * Tests that need real infrastructure skip themselves when the variable is
 * absent, so the suite still passes in CI without secrets.
 */
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });

// Tests often run from a laptop rather than from a function next to the
// cluster, so give server selection more room than production needs. Only set
// when the developer has not chosen a value themselves.
process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS ??= "25000";
