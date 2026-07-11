/**
 * Disk persistence for checkpoint-fork resume.
 *
 * The provider keeps checkpoints (pi-session prefix -> CLI session id) in an
 * in-memory Map so a follow-up turn can fork the exact CLI session a prior turn
 * established. That Map dies with the process: after the user quits the TUI and
 * reopens the same session (`-r` / `-c`), the first turn finds no checkpoint and
 * has to replay the entire flattened history under a fresh session — the
 * expensive `no_matching_checkpoint` / `fresh_full` path.
 *
 * This module mirrors that Map to disk (one JSON file per pi session) so a
 * reopened session can fork the CLI session its previous run created and send
 * only the delta.
 *
 * Safety: a persisted checkpoint points at a Claude Code CLI session that Claude
 * may have since deleted (its own retention/cleanup, a manual clear, a different
 * machine). Forking a session that no longer exists fails the turn.
 * `cliSessionExists` lets the provider verify a disk-loaded parent before
 * trusting it and fall back to a fresh session otherwise — so the worst case is
 * the pre-persistence behavior, never a broken turn.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type PersistedCheckpoint = {
  turnCount: number;
  prefixHash: string;
  cliSessionId: string;
};

function enabled(): boolean {
  const value = process.env.PI_CLAUDE_CLI_PERSIST_CHECKPOINTS;
  // Default ON; explicit falsey values disable.
  return !(
    value === "0" ||
    value === "false" ||
    value === "no" ||
    value === "off"
  );
}

function checkpointDir(): string {
  return (
    process.env.PI_CLAUDE_CLI_CHECKPOINT_DIR ??
    join(homedir(), ".pi", "claude-cli", "checkpoints")
  );
}

/** pi session ids are UUIDs, but sanitize defensively so the id can't escape the dir. */
function fileFor(piSessionId: string): string {
  const safe = piSessionId.replace(/[^A-Za-z0-9_-]/g, "_");
  return join(checkpointDir(), `${safe}.json`);
}

/** Claude Code's project store: $CLAUDE_CONFIG_DIR/projects, else ~/.claude/projects. */
function claudeProjectsDir(): string {
  const base = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  return join(base, "projects");
}

/** Retention for persisted checkpoint files; 0 or negative disables pruning. */
function retentionDays(): number {
  const raw = process.env.PI_CLAUDE_CLI_CHECKPOINT_RETENTION_DAYS;
  if (raw === undefined) return 30;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 30;
}

/**
 * Whether a Claude Code CLI session transcript still exists on disk. Claude
 * stores one `<session-id>.jsonl` per session under a per-cwd project directory
 * whose name is a lossy encoding of the cwd. Rather than reproduce that
 * (version-dependent) encoding, scan every project directory for the file —
 * session ids are UUIDs, so a hit is unambiguous. Returns false on any error,
 * which makes the caller fall back to a fresh session (fail-safe).
 */
export function cliSessionExists(cliSessionId: string): boolean {
  const file = `${cliSessionId}.jsonl`;
  try {
    const root = claudeProjectsDir();
    for (const entry of readdirSync(root)) {
      if (existsSync(join(root, entry, file))) return true;
    }
  } catch {
    // projects dir missing / unreadable — treat as "cannot confirm" -> fresh.
  }
  return false;
}

export function loadCheckpoints(
  piSessionId: string,
): PersistedCheckpoint[] | undefined {
  if (!enabled()) return undefined;
  try {
    const raw = readFileSync(fileFor(piSessionId), "utf8");
    const parsed = JSON.parse(raw);
    const list = parsed?.checkpoints;
    if (!Array.isArray(list) || list.length === 0) return undefined;
    // Keep only well-formed entries.
    const clean = list.filter(
      (c: any) =>
        c &&
        typeof c.turnCount === "number" &&
        typeof c.prefixHash === "string" &&
        typeof c.cliSessionId === "string",
    );
    return clean.length ? clean : undefined;
  } catch {
    return undefined;
  }
}

export function saveCheckpoints(
  piSessionId: string,
  checkpoints: PersistedCheckpoint[],
): void {
  if (!enabled()) return;
  const dir = checkpointDir();
  try {
    mkdirSync(dir, { recursive: true });
    // Strip any runtime-only fields; persist just the three durable ones.
    const durable = checkpoints.map((c) => ({
      turnCount: c.turnCount,
      prefixHash: c.prefixHash,
      cliSessionId: c.cliSessionId,
    }));
    writeFileSync(
      fileFor(piSessionId),
      JSON.stringify({ checkpoints: durable }),
      "utf8",
    );
    pruneOldCheckpoints(dir);
  } catch {
    // Persistence is best-effort — never break a turn over it.
  }
}

/**
 * Best-effort removal of checkpoint files not modified within the retention
 * window. Scoped to `*.json` files in our own directory.
 */
export function pruneOldCheckpoints(dir: string): void {
  const days = retentionDays();
  if (days <= 0) return;
  const cutoffMs = days * 24 * 60 * 60 * 1000;
  const now = new Date().getTime();
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const full = join(dir, name);
      try {
        if (now - statSync(full).mtimeMs > cutoffMs) {
          rmSync(full, { force: true });
        }
      } catch {
        // ignore individual file errors
      }
    }
  } catch {
    // ignore
  }
}
