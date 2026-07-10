import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
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

function logPath(): string {
  return (
    process.env.PI_CLAUDE_CLI_USAGE_LOG_PATH ??
    join(homedir(), ".pi", "claude-cli", "usage.jsonl")
  );
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

  const path = logPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
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
