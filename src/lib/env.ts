/**
 * env.ts — every environment variable the app reads, in one place.
 *
 * WHY LAZY: local scripts like `check-sources` only need a User-Agent, while the
 * poll route needs Mongo and Telegram. Validating everything at import time would
 * make simple scripts fail for missing variables they never touch. So each getter
 * validates only what it is asked for, and throws a clear message if it is absent.
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env.local and fill it in.`,
    );
  }
  return v;
}

function optional(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v : undefined;
}

function num(name: string, fallback: number): number {
  const v = optional(name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Environment variable ${name} must be a number, got "${v}".`);
  return n;
}

export const env = {
  // --- Storage ---
  get mongodbUri(): string {
    return required("MONGODB_URI");
  },
  get mongodbDb(): string {
    return optional("MONGODB_DB") ?? "fintech_deal_radar";
  },
  /**
   * How long the driver may spend finding a usable server. 8s is right for a
   * function sitting in the same region as the cluster. Raise it if you are
   * running the scripts from a slow or distant connection, where a cold
   * mongodb+srv connect (DNS SRV, TLS, replica-set discovery) takes longer.
   */
  get mongodbServerSelectionTimeoutMs(): number {
    return num("MONGODB_SERVER_SELECTION_TIMEOUT_MS", 8_000);
  },

  // --- Telegram ---
  get telegramBotToken(): string {
    return required("TELEGRAM_BOT_TOKEN");
  },
  get telegramChatId(): string {
    return required("TELEGRAM_CHAT_ID");
  },
  get telegramWebhookSecret(): string {
    return required("TELEGRAM_WEBHOOK_SECRET");
  },
  /**
   * Public channel for deal alerts, e.g. "@fintechdealradar" or a numeric
   * "-1001234567890". Optional: unset means alerts go to the owner's DM only.
   *
   * Operational messages (health warnings, daily summary, bot replies) always
   * go to TELEGRAM_CHAT_ID regardless — subscribers should not see that a feed
   * is down, and must not be able to run /pause.
   */
  get telegramChannelId(): string | undefined {
    return optional("TELEGRAM_CHANNEL_ID");
  },
  /**
   * Whether the owner also receives a DM copy of every alert once a channel is
   * configured. Defaults to false: with a channel set up, duplicating every
   * alert into the DM buries the operational messages that live there.
   */
  get alsoDmAlerts(): boolean {
    return (optional("ALSO_DM_ALERTS") ?? "false").toLowerCase() === "true";
  },

  // --- Scheduling / auth ---
  get cronSecret(): string {
    return required("CRON_SECRET");
  },
  get dashboardPassword(): string {
    return required("DASHBOARD_PASSWORD");
  },
  get appUrl(): string {
    return required("APP_URL").replace(/\/+$/, "");
  },

  // --- AI ---
  get geminiApiKey(): string {
    return required("GEMINI_API_KEY");
  },
  get geminiApiKeyOptional(): string | undefined {
    return optional("GEMINI_API_KEY");
  },
  get geminiModel(): string {
    return optional("GEMINI_MODEL") ?? "gemini-3.5-flash-lite";
  },
  get geminiDailyLimit(): number {
    return num("GEMINI_DAILY_LIMIT", 900);
  },
  /**
   * A SECOND Gemini model used once the primary model's daily free quota is
   * spent. Google's free-tier limits are per model, so this is genuinely extra
   * free headroom rather than the same bucket under another name. Set to an
   * empty string to disable and go straight to unverified alerts.
   */
  get geminiFallbackModel(): string | undefined {
    return optional("GEMINI_FALLBACK_MODEL");
  },
  get geminiFallbackDailyLimit(): number {
    return num("GEMINI_FALLBACK_DAILY_LIMIT", 200);
  },
  get alertMinConfidence(): number {
    return num("ALERT_MIN_CONFIDENCE", 0.7);
  },

  // --- HTTP identity ---
  /** EDGAR rejects requests without a descriptive UA containing contact info. */
  get secUserAgent(): string {
    return required("SEC_USER_AGENT");
  },
  get appUserAgent(): string {
    return optional("APP_USER_AGENT") ?? "FintechDealRadar/1.0 (monitoring bot; contact via repo owner)";
  },
};

/** Tunables that are unlikely to change but should not be magic numbers. */
export const limits = {
  /**
   * Hard stop for a whole poll cycle, against Vercel's 60s maxDuration.
   *
   * The brief called for 25s. Measured reality forced this up: free-tier Gemini
   * has a ~16s MEDIAN response time with a 54s worst case, so a 25s cap would
   * abort classification on a meaningful fraction of cycles and those items
   * would never get classified at all. 45s leaves 15s of headroom under
   * maxDuration while letting a normal classify call finish.
   *
   * The memory cost is modest because only a minority of cycles classify: at
   * roughly 4.4s average wall time across 43,200 monthly invocations at 2GB,
   * that is about 105 of the 360 GB-hours Hobby allows. See README.
   */
  cycleBudgetMs: num("CYCLE_BUDGET_MS", 45_000),
  /**
   * Slice of the cycle budget a single classify call may consume. Bounded so a
   * pathologically slow model response still leaves time to save state.
   */
  classifyBudgetMs: num("CLASSIFY_BUDGET_MS", 30_000),
  /** Per-feed fetch timeout. A slow feed is skipped and retried next cycle. */
  feedTimeoutMs: num("FEED_TIMEOUT_MS", 5_000),
  /** Per-article fetch timeout when enriching a candidate. */
  articleTimeoutMs: num("ARTICLE_TIMEOUT_MS", 5_000),
  /** Most full article pages we will fetch in one cycle. */
  maxArticleFetchesPerCycle: num("MAX_ARTICLE_FETCHES", 5),
  /** Most candidates sent to the AI in a single batched request. */
  maxClassifierBatch: num("MAX_CLASSIFIER_BATCH", 15),
  /** How long a cycle may hold the overlap lease before it is considered dead. */
  lockTtlMs: 90_000,
} as const;
