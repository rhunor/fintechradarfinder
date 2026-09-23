/**
 * _bootstrap.ts — loads local secrets for CLI scripts.
 *
 * Next.js loads .env.local automatically, but plain `tsx` scripts do not, so
 * every script imports this first. Production reads real environment variables
 * from Vercel and these files are absent, which is fine — nothing is overwritten.
 */
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });
