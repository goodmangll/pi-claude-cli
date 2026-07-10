import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type UsageLogMode = "fresh_full" | "legacy_resume_delta" | "fork_delta";

export type UsageLogRecordInput = {
  mode: UsageLogMode;
  decisionReason: string;
  model: string;
  piSessionId?: string;
  cliSessionId?: string;
  forkParentId?: string;
  resumeSessionId?: string;
  messageCount: number;
  deltaStart: number;
  checkpointTurnCount?: number;
  promptChars: number;
  systemPrompt?: string;
  usage: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
};

function enabled(): boolean {
  const value = process.env.PI_CLAUDE_CLI_USAGE_LOG;
  return value === "1" || value === "true" || value === "yes";
}

function debugEnabled(): boolean {
  const value = process.env.PI_CLAUDE_CLI_USAGE_DEBUG;
  return value === "1" || value === "true" || value === "yes";
}

/** Filename of a daily shard, e.g. usage-2026-07-11.jsonl. */
const SHARD_RE = /^usage-\d{4}-\d{2}-\d{2}\.jsonl$/;

/** Daily shard filename for a given date (default: now). Exported for tests. */
export function todayShard(date: Date = new Date()): string {
  return `usage-${date.toISOString().slice(0, 10)}.jsonl`;
}

/**
 * Where to append this record.
 *
 * An explicit PI_CLAUDE_CLI_USAGE_LOG_PATH is honored verbatim (no sharding),
 * so callers that want one exact file — tests, ad-hoc captures — keep it.
 *
 * The default path is sharded per UTC day (usage-YYYY-MM-DD.jsonl) so the log
 * rotates on its own instead of growing without bound. Retention pruning
 * (see pruneOldShards) keeps only recent shards.
 */
function logPath(): { path: string; sharded: boolean } {
  const override = process.env.PI_CLAUDE_CLI_USAGE_LOG_PATH;
  if (override) return { path: override, sharded: false };
  return {
    path: join(homedir(), ".pi", "claude-cli", todayShard()),
    sharded: true,
  };
}

/** Retention window for daily shards; 0 or negative disables pruning. */
function retentionDays(): number {
  const raw = process.env.PI_CLAUDE_CLI_USAGE_RETENTION_DAYS;
  if (raw === undefined) return 30;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 30;
}

/**
 * Best-effort removal of daily shards older than the retention window. Scoped
 * strictly to files matching the `usage-YYYY-MM-DD.jsonl` shard pattern in our
 * own directory, so it can never touch anything else. Failures are swallowed
 * (with a debug note) — pruning must never break logging.
 */
export function pruneOldShards(dir: string): void {
  const days = retentionDays();
  if (days <= 0) return;
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  const cutoffKey = cutoff.toISOString().slice(0, 10);
  try {
    for (const name of readdirSync(dir)) {
      if (!SHARD_RE.test(name)) continue;
      const dateKey = name.slice("usage-".length, "usage-".length + 10);
      if (dateKey < cutoffKey) {
        rmSync(join(dir, name), { force: true });
      }
    }
  } catch (err: any) {
    if (debugEnabled()) {
      console.warn(
        `[pi-claude-cli] failed to prune usage shards: ${err?.message ?? String(err)}`,
      );
    }
  }
}

function hashValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

export function usageLogHash(value: string | undefined): string | undefined {
  return hashValue(value);
}

export function appendUsageLog(input: UsageLogRecordInput): void {
  if (!enabled()) return;

  const inputTokens = input.usage.input ?? 0;
  const outputTokens = input.usage.output ?? 0;
  const cacheReadInputTokens = input.usage.cacheRead ?? 0;
  const cacheCreationInputTokens = input.usage.cacheWrite ?? 0;
  const cacheDenominator =
    inputTokens + cacheReadInputTokens + cacheCreationInputTokens;
  const readRatio =
    cacheDenominator > 0 ? cacheReadInputTokens / cacheDenominator : 0;

  const record = {
    timestamp: new Date().toISOString(),
    mode: input.mode,
    decisionReason: input.decisionReason,
    model: input.model,
    messageCount: input.messageCount,
    deltaStart: input.deltaStart,
    checkpointTurnCount: input.checkpointTurnCount,
    ids: {
      piSessionIdHash: hashValue(input.piSessionId),
      cliSessionIdHash: hashValue(input.cliSessionId),
      forkParentIdHash: hashValue(input.forkParentId),
      resumeSessionIdHash: hashValue(input.resumeSessionId),
    },
    usage: {
      inputTokens,
      outputTokens,
      cacheReadInputTokens,
      cacheCreationInputTokens,
    },
    cache: {
      readRatio,
      missLikely: cacheDenominator > 0 && cacheReadInputTokens === 0,
    },
    prompt: {
      fullPromptChars: input.promptChars,
      systemPromptHash: hashValue(input.systemPrompt),
    },
  };

  const { path, sharded } = logPath();
  try {
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
    if (sharded) pruneOldShards(dir);
    if (debugEnabled()) {
      console.warn(
        `[pi-claude-cli] usage mode=${record.mode} input=${inputTokens} cacheRead=${cacheReadInputTokens} cacheCreate=${cacheCreationInputTokens} output=${outputTokens} cacheReadRatio=${Math.round(readRatio * 100)}%`,
      );
    }
  } catch (err: any) {
    if (debugEnabled()) {
      console.warn(
        `[pi-claude-cli] failed to write usage log: ${err?.message ?? String(err)}`,
      );
    }
  }
}
