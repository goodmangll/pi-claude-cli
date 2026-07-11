/**
 * Opt-in diagnostics for pinpointing checkpoint fingerprint drift.
 *
 * The fingerprint (fingerprintMessages) hashes the raw bytes of each prefix
 * message's role/content/toolName. When a strictly-appended conversation
 * nonetheless takes the `no_matching_checkpoint` path, it means some message in
 * the prefix serialized differently between the turn that SAVED a checkpoint and
 * the turn re-checking it — i.e. a field inside `content` drifted even though the
 * user didn't rewind. This module finds exactly which message and which field.
 *
 * Enable with PI_CLAUDE_CLI_CHECKPOINT_DEBUG=1. When on, we keep an in-memory
 * deep-copied snapshot of the prefix each checkpoint was saved against; on a
 * match failure we diff the current prefix against every stored snapshot and log
 * the first divergence (message index + JSON path). Memory-only and same-process
 * — which is exactly the drift case observed in real logs (continuous append,
 * no restart). Off by default; zero cost when disabled.
 */

export function checkpointDebugEnabled(): boolean {
  const v = process.env.PI_CLAUDE_CLI_CHECKPOINT_DEBUG;
  return v === "1" || v === "true" || v === "yes";
}

/** piSessionId -> (turnCount -> deep-copied prefix snapshot at save time). */
const snapshots = new Map<string, Map<number, any[]>>();

/** Deep structural clone independent of the live message objects. */
function clone(value: any): any {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Record the exact prefix a checkpoint was fingerprinted against, so a later
 * mismatch can be diffed against it. No-op unless debugging is enabled.
 */
export function snapshotPrefix(
  piSessionId: string,
  turnCount: number,
  messages: any[],
): void {
  if (!checkpointDebugEnabled()) return;
  let perSession = snapshots.get(piSessionId);
  if (!perSession) {
    perSession = new Map();
    snapshots.set(piSessionId, perSession);
  }
  try {
    perSession.set(turnCount, clone(messages.slice(0, turnCount)));
  } catch {
    // A message that can't be JSON-cloned can't be fingerprinted either;
    // skip it rather than throw inside a diagnostic path.
  }
}

/** The projection the fingerprint actually hashes, for field-level diffing. */
function projection(m: any): any {
  return { role: m?.role, content: m?.content, toolName: m?.toolName };
}

/**
 * Find the first JSON path at which two values structurally differ.
 * Returns null when equal. Depth-first, arrays and objects walked by key/index.
 */
function firstDiffPath(a: any, b: any, path = ""): string | null {
  if (a === b) return null;
  const ta = Array.isArray(a) ? "array" : a === null ? "null" : typeof a;
  const tb = Array.isArray(b) ? "array" : b === null ? "null" : typeof b;
  if (ta !== tb) return `${path || "<root>"} (type ${ta} -> ${tb})`;
  if (ta === "array") {
    if (a.length !== b.length) {
      return `${path}.length (${a.length} -> ${b.length})`;
    }
    for (let i = 0; i < a.length; i++) {
      const d = firstDiffPath(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (ta === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (!(k in a)) return `${path}.${k} (added)`;
      if (!(k in b)) return `${path}.${k} (removed)`;
      const d = firstDiffPath(a[k], b[k], path ? `${path}.${k}` : k);
      if (d) return d;
    }
    return null;
  }
  // Primitives that aren't ===.
  const av = typeof a === "string" && a.length > 40 ? `${a.slice(0, 40)}…` : a;
  const bv = typeof b === "string" && b.length > 40 ? `${b.slice(0, 40)}…` : b;
  return `${path || "<root>"} (${JSON.stringify(av)} -> ${JSON.stringify(bv)})`;
}

/**
 * On a checkpoint match failure, diff the current prefix against the snapshot
 * taken when the closest checkpoint was saved, and log the first drifting
 * message + field path. No-op unless debugging is enabled.
 */
export function reportMismatch(
  piSessionId: string,
  turnCountsTried: number[],
  currentMessages: any[],
): void {
  if (!checkpointDebugEnabled()) return;
  const perSession = snapshots.get(piSessionId);
  if (!perSession) return;

  for (const turnCount of turnCountsTried) {
    const saved = perSession.get(turnCount);
    if (!saved) continue;
    let firstDivergence: string | null = null;
    let divergedAt = -1;
    for (let i = 0; i < turnCount; i++) {
      const d = firstDiffPath(
        projection(saved[i]),
        projection(currentMessages[i]),
      );
      if (d) {
        firstDivergence = d;
        divergedAt = i;
        break;
      }
    }
    if (firstDivergence) {
      console.warn(
        `[pi-claude-cli] checkpoint drift @turnCount=${turnCount}: message[${divergedAt}] field ${firstDivergence}`,
      );
    } else {
      console.warn(
        `[pi-claude-cli] checkpoint @turnCount=${turnCount} prefix is byte-identical under projection but fingerprint differed — investigate hash inputs`,
      );
    }
    return; // one report per mismatch is enough
  }
}

/** Test-only reset so module state doesn't leak across cases. */
export function clearCheckpointDiagnostics(): void {
  snapshots.clear();
}
