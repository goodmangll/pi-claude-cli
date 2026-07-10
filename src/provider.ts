/**
 * Provider orchestration for bridging pi requests to the Claude CLI subprocess.
 *
 * streamViaCli is the core function that:
 * 1. Builds the prompt from conversation context
 * 2. Spawns a Claude CLI subprocess with correct flags
 * 3. Writes the user message to stdin as NDJSON
 * 4. Reads stdout line-by-line, parsing NDJSON
 * 5. Routes stream events through the event bridge to pi's stream
 * 6. Handles result/error messages and cleans up the subprocess
 * 7. Implements break-early: kills subprocess at message_stop when
 *    built-in or custom-tools MCP tool_use blocks are seen
 * 8. Hardened lifecycle: inactivity timeout, subprocess exit handler,
 *    streamEnded guard, abort via SIGKILL, process registry
 */

import { createInterface } from "node:readline";
import { createHash, randomUUID } from "node:crypto";
import {
  AssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import {
  buildPrompt,
  buildSystemPrompt,
  buildResumePrompt,
  resumeDeltaStartIndex,
} from "./prompt-builder.js";
import {
  spawnClaude,
  writeUserMessage,
  cleanupProcess,
  captureStderr,
  forceKillProcess,
  registerProcess,
  cleanupSystemPromptFile,
} from "./process-manager.js";
import { parseLine } from "./stream-parser.js";
import { createEventBridge } from "./event-bridge.js";
import { handleControlRequest } from "./control-handler.js";
import { mapThinkingEffort } from "./thinking-config.js";
import { isPiKnownClaudeTool } from "./tool-mapping.js";
import { appendUsageLog, type UsageLogMode } from "./usage-log.js";
/** Inactivity timeout: kill subprocess if no stdout for 180 seconds (3 minutes). */
const INACTIVITY_TIMEOUT_MS = 180_000;

/**
 * A checkpoint records that a Claude CLI session (`cliSessionId`) embodies the
 * first `turnCount` messages of a pi conversation (fingerprinted by
 * `prefixHash`). Because the CLI reconstructs that context on `--resume`, we
 * can fork a checkpoint into a fresh session and send only the new delta —
 * paying for the delta's tokens, not a full-history replay.
 */
type Checkpoint = {
  turnCount: number;
  prefixHash: string;
  cliSessionId: string;
};

/**
 * Checkpoint-fork resume store.
 *
 * pi's ESC-ESC "rewind conversation history" truncates pi's own
 * `context.messages`, but a Claude CLI session keeps the full pre-rewind
 * history. A blind `--resume` would replay turns the user rewound away.
 *
 * Instead of resuming a session in place, every turn *forks* the best-matching
 * checkpoint (`claude --resume <cp> --fork-session --session-id <new>`), which
 * leaves the parent frozen and re-forkable. We keep one checkpoint per turn
 * (keyed by pi's stable session id):
 *
 *   - strict append -> fork the newest checkpoint, send the delta;
 *   - rewind / edit  -> fork the deepest checkpoint that still matches the
 *                       incoming history prefix, send the delta from there;
 *   - no match at all -> a fresh session with the full history.
 *
 * This makes a rewind cost one delta (reusing the forked context + its prompt
 * cache) instead of a full replay under a brand-new session. Verified against
 * `claude` 2.0.60: fork reconstructs context, honors an explicit
 * `--session-id`, and the parent survives repeated forks.
 */
const sessionCheckpoints = new Map<string, Checkpoint[]>();

/**
 * Test-only: reset the checkpoint store. Module-level state would otherwise
 * leak between test cases that reuse session ids.
 */
export function clearSessionCheckpoints(): void {
  sessionCheckpoints.clear();
}

/**
 * Stable SHA-256 fingerprint of the first `count` messages. Used to detect
 * whether a new request strictly extends the previously-sent history (safe to
 * `--resume`) or diverges from it (rewind/edit — must start a fresh session).
 */
function fingerprintMessages(messages: any[], count: number): string {
  const hash = createHash("sha256");
  for (let i = 0; i < count; i++) {
    const m = messages[i];
    hash.update(
      JSON.stringify({
        role: m?.role,
        content: m?.content,
        toolName: m?.toolName,
      }),
    );
    hash.update("\u0000");
  }
  return hash.digest("hex");
}

/** Extended stream options: pi's SimpleStreamOptions plus optional cwd and mcpConfigPath */
type StreamViaCLiOptions = SimpleStreamOptions & {
  cwd?: string;
  mcpConfigPath?: string;
};

/**
 * Stream a response from Claude CLI as an AssistantMessageEventStream.
 *
 * Orchestrates the full subprocess lifecycle: spawn, write prompt, parse NDJSON,
 * bridge events, handle result, and clean up. Implements break-early pattern:
 * at message_stop, if any built-in or custom-tools MCP tool was seen, kills
 * the subprocess before Claude CLI can auto-execute the tools.
 *
 * Hardened with: inactivity timeout (180s), subprocess exit handler with stderr
 * surfacing, streamEnded guard against double errors, abort via SIGKILL, and
 * process registry integration for teardown cleanup.
 *
 * @param model - The model to use (from pi's model catalog)
 * @param context - The conversation context with messages and system prompt
 * @param options - Optional cwd, abort signal, reasoning level, thinking budgets, and mcpConfigPath
 * @returns An AssistantMessageEventStream that receives bridged events
 */
export function streamViaCli(
  model: Model<any>,
  context: { messages: any[]; systemPrompt?: string },
  options?: StreamViaCLiOptions,
): AssistantMessageEventStream {
  // @ts-expect-error — tsc can't verify AssistantMessageEventStream is a value
  // through pi-ai's `export *` re-export chain. The class constructor exists at runtime.
  const stream = new AssistantMessageEventStream();

  (async () => {
    let proc: ReturnType<typeof spawnClaude> | undefined;
    let abortHandler: (() => void) | undefined;

    try {
      const cwd = options?.cwd ?? process.cwd();

      const messages = context.messages as any[];
      const hasPriorCliTurn = messages.some(
        (m) =>
          m?.role === "assistant" &&
          (m?.provider === "pi-claude-cli" || m?.api === "pi-claude-cli"),
      );

      // Resume decision (see sessionCheckpoints). The delta boundary follows the
      // chosen checkpoint: everything from its turnCount onward is the delta,
      // and everything before it the CLI session is expected to already hold.
      const checkpoints = options?.sessionId
        ? sessionCheckpoints.get(options.sessionId)
        : undefined;

      // Best checkpoint = the deepest one (largest turnCount) whose fingerprint
      // still matches the incoming history prefix AND whose tail (turnCount ..
      // end) contains only our own assistant turns. The tail's assistant
      // messages are dropped by buildResumePrompt (the forked session already
      // holds them), so any foreign-provider assistant there — e.g. a turn
      // produced by another provider after a /model switch — would be silently
      // lost; such a checkpoint is rejected and we start fresh instead.
      //
      // Note we deliberately do NOT bound candidates by the last-user-message
      // index: during an agentic tool loop no new user message arrives, so that
      // index stays pinned at the original prompt and would reject every
      // checkpoint, forcing a full-history replay on every tool step.
      let best: Checkpoint | undefined;
      if (checkpoints) {
        for (const cp of checkpoints) {
          if (cp.turnCount >= messages.length) continue;
          if (fingerprintMessages(messages, cp.turnCount) !== cp.prefixHash) {
            continue;
          }
          let tailOk = true;
          for (let i = cp.turnCount; i < messages.length; i++) {
            const m = messages[i];
            if (
              m?.role === "assistant" &&
              !(m?.provider === "pi-claude-cli" || m?.api === "pi-claude-cli")
            ) {
              tailOk = false;
              break;
            }
          }
          if (tailOk && (!best || cp.turnCount > best.turnCount)) best = cp;
        }
      }
      // Delta boundary for logging / prompt building: the chosen checkpoint's
      // turnCount when forking, else the last-user-message heuristic.
      const deltaStart = best
        ? best.turnCount
        : resumeDeltaStartIndex(messages);

      let forkParentId: string | undefined;
      let resumeSessionId: string | undefined;
      let newSessionId: string | undefined;
      let usageLogMode: UsageLogMode = "fresh_full";
      let decisionReason = "first_turn_or_no_prior_cli_turn";
      let checkpointTurnCount: number | undefined;
      if (best) {
        // Fork the matching checkpoint into a fresh id and send only the delta.
        // The parent stays frozen and re-forkable for future rewinds.
        forkParentId = best.cliSessionId;
        newSessionId = randomUUID();
        usageLogMode = "fork_delta";
        decisionReason = "deepest_checkpoint_match";
        checkpointTurnCount = best.turnCount;
      } else if (checkpoints && checkpoints.length > 0) {
        // Have checkpoints but none match — the whole history diverged. Start a
        // fresh session (random id; pi's id already names an on-disk session).
        newSessionId = randomUUID();
        decisionReason = "no_matching_checkpoint";
      } else if (options?.sessionId && hasPriorCliTurn) {
        // No checkpoints (e.g. pi restarted, extension reloaded) but history
        // shows a prior CLI turn: fall back to resuming pi's session id in
        // place. It becomes a checkpoint below and is forked from then on.
        resumeSessionId = options.sessionId;
        usageLogMode = "legacy_resume_delta";
        decisionReason = "legacy_resume_without_checkpoints";
      } else {
        // First turn: create the session under pi's id when we have one.
        newSessionId = options?.sessionId;
      }

      // Fork and legacy-resume both send only the delta (the CLI holds the
      // rest); a fresh session gets the full flattened history + system prompt.
      const useDelta = !!(forkParentId || resumeSessionId);

      // Snapshot of what this turn establishes; committed to the checkpoint
      // store only after the turn completes successfully (an errored turn may
      // not have persisted a CLI session to fork).
      const cliSessionIdUsed = newSessionId ?? resumeSessionId;
      const pendingCheckpoint =
        options?.sessionId && cliSessionIdUsed
          ? {
              piSessionId: options.sessionId,
              entry: {
                cliSessionId: cliSessionIdUsed,
                turnCount: messages.length,
                prefixHash: fingerprintMessages(messages, messages.length),
              } as Checkpoint,
            }
          : undefined;

      const prompt = useDelta
        ? buildResumePrompt(context, deltaStart)
        : buildPrompt(context);
      const systemPrompt = useDelta
        ? undefined
        : buildSystemPrompt(context, cwd);

      // Compute effort level from reasoning options
      const effort = mapThinkingEffort(
        options?.reasoning,
        model.id,
        options?.thinkingBudgets,
      );

      // Spawn subprocess
      proc = spawnClaude(model.id, systemPrompt || undefined, {
        cwd,
        signal: options?.signal,
        effort,
        mcpConfigPath: options?.mcpConfigPath,
        resumeSessionId,
        newSessionId,
        forkParentId,
      });
      const getStderr = captureStderr(proc);

      // Register in global process registry for teardown cleanup
      registerProcess(proc);

      // Write user message to subprocess stdin
      writeUserMessage(proc, prompt);

      // Create event bridge (before endStreamWithError so bridge is in scope)
      const bridge = createEventBridge(stream, model);

      // Guard against double stream.end() and double error events.
      // First error path wins; subsequent ones are no-ops.
      let streamEnded = false;

      /**
       * End the stream with an error, using a "done" event instead of "error".
       *
       * Why "done" not "error": AssistantMessageEventStream.extractResult()
       * returns event.error (a string) for error events, but agent-loop.js
       * then calls message.content.filter() on the result, crashing because
       * a string has no .content property. By pushing "done" with a valid
       * AssistantMessage (content:[]), pi gets a well-formed object.
       */
      function endStreamWithError(errMsg: string) {
        if (streamEnded || broken) return;
        streamEnded = true;
        const output = bridge.getOutput();
        const errorMessage = {
          ...output,
          content: output.content?.length
            ? output.content
            : [{ type: "text" as const, text: `Error: ${errMsg}` }],
          stopReason: "stop" as const,
        };
        stream.push({
          type: "done",
          reason: "stop",
          message: errorMessage,
        } as any);
        stream.end();
      }

      // Inactivity timeout: kill subprocess if no stdout for INACTIVITY_TIMEOUT_MS
      let inactivityTimer: ReturnType<typeof setTimeout> | undefined;

      function resetInactivityTimer() {
        if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => {
          forceKillProcess(proc!);
          endStreamWithError(
            `Claude CLI subprocess timed out: no output for ${INACTIVITY_TIMEOUT_MS / 1000} seconds`,
          );
        }, INACTIVITY_TIMEOUT_MS);
      }

      // Set up abort signal handler -- uses SIGKILL for immediate force-kill
      if (options?.signal) {
        abortHandler = () => {
          if (proc) {
            forceKillProcess(proc);
          }
        };

        if (options.signal.aborted) {
          abortHandler();
          return;
        }
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }

      // Track tool_use blocks for break-early decision at message_stop
      let sawBuiltInOrCustomTool = false;
      // Guard against buffered readline lines firing after rl.close()
      let broken = false;

      // Set up readline for line-by-line NDJSON parsing
      const rl = createInterface({
        input: proc.stdout!,
        crlfDelay: Infinity,
        terminal: false,
      });

      // Handle process error -- use endStreamWithError for guard
      proc.on("error", (err: Error) => {
        if (broken) return; // Break-early killed the process intentionally
        const stderr = getStderr();
        endStreamWithError(stderr || err.message);
      });

      // Handle subprocess close -- surface crashes with stderr and exit code
      proc.on("close", (code: number | null, _signal: string | null) => {
        clearTimeout(inactivityTimer);
        if (broken) return; // Break-early kill, expected
        if (code !== 0 && code !== null) {
          const stderr = getStderr();
          const message = stderr
            ? `Claude CLI exited with code ${code}: ${stderr.trim()}`
            : `Claude CLI exited unexpectedly with code ${code}`;
          endStreamWithError(message);
        }
      });

      // Start inactivity timer after writing user message
      resetInactivityTimer();

      // Process NDJSON lines from stdout using event-based callback
      // NOTE: Using 'line' event instead of `for await` because the async
      // iterator batches lines, breaking real-time streaming to pi.
      rl.on("line", (line: string) => {
        if (broken) return; // Guard: ignore buffered lines after break-early

        // Reset inactivity timer on each line of output
        resetInactivityTimer();

        const msg = parseLine(line);
        if (!msg) return;

        if (msg.type === "stream_event") {
          // Only forward top-level events to pi's event bridge.
          // Sub-agent events (parent_tool_use_id !== null) are internal to the CLI.
          const isTopLevel = !(msg as any).parent_tool_use_id;
          if (isTopLevel) {
            bridge.handleEvent(msg.event);
          }

          // Track tool_use blocks for break-early decision (top-level only)
          if (
            isTopLevel &&
            msg.event.type === "content_block_start" &&
            msg.event.content_block?.type === "tool_use"
          ) {
            const toolName = msg.event.content_block.name;
            if (toolName && isPiKnownClaudeTool(toolName)) {
              // Built-in tool (Read/Write/etc.) OR custom MCP tool (mcp__custom-tools__*)
              // Internal Claude Code tools (ToolSearch, Task, etc.) are excluded
              sawBuiltInOrCustomTool = true;
            }
          }

          // Break-early at message_stop: kill subprocess before CLI auto-executes tools
          // Only on top-level message_stop — sub-agent message_stop is internal
          if (
            isTopLevel &&
            msg.event.type === "message_stop" &&
            sawBuiltInOrCustomTool
          ) {
            broken = true; // Set guard BEFORE rl.close() to prevent buffered lines
            clearTimeout(inactivityTimer);
            // Pi will execute these tools. Kill subprocess to prevent CLI from executing them.
            forceKillProcess(proc!);
            rl.close();
            return; // Don't process further -- done event already pushed by event bridge
          }
        } else if (msg.type === "control_request") {
          handleControlRequest(msg, proc!.stdin!);
        } else if (msg.type === "result") {
          // Surface every non-success result as an error so silent failures
          // (e.g. subtype "error_during_execution" from --resume against an
          // unknown session id, or any future error variant) don't get
          // swallowed into an empty assistant message.
          const r: any = msg as any;
          const isError =
            r.subtype !== "success" ||
            r.is_error === true ||
            typeof r.error === "string" ||
            (Array.isArray(r.errors) && r.errors.length > 0);
          if (isError) {
            const errMsg =
              r.error ??
              (Array.isArray(r.errors) && r.errors.length > 0
                ? r.errors.join("; ")
                : `Claude CLI returned ${r.subtype ?? "non-success result"}`);
            endStreamWithError(errMsg);
          }
          // For both success and error: clean up the subprocess
          clearTimeout(inactivityTimer);
          cleanupProcess(proc!);
          rl.close();
        }
      });

      // Wait for readline to close (result received or process ended)
      await new Promise<void>((resolve) => {
        rl.on("close", resolve);
      });

      // Push done event after readline closes (async). Pushing synchronously
      // inside handleMessageStop prevents pi from executing tools.
      // Guard with streamEnded to avoid pushing done after an error was already pushed.
      if (!streamEnded) {
        // Turn completed successfully: append a checkpoint so the next turn can
        // fork the exact state this turn established (and earlier ones remain
        // available for a deeper rewind).
        if (pendingCheckpoint) {
          const list =
            sessionCheckpoints.get(pendingCheckpoint.piSessionId) ?? [];
          list.push(pendingCheckpoint.entry);
          sessionCheckpoints.set(pendingCheckpoint.piSessionId, list);
        }

        const output = bridge.getOutput();

        appendUsageLog({
          mode: usageLogMode,
          decisionReason,
          model: model.id,
          piSessionId: options?.sessionId,
          cliSessionId: cliSessionIdUsed,
          forkParentId,
          resumeSessionId,
          messageCount: messages.length,
          deltaStart,
          checkpointTurnCount,
          promptChars:
            typeof prompt === "string"
              ? prompt.length
              : JSON.stringify(prompt).length,
          systemPrompt,
          usage: output.usage,
        });

        // If stopReason is toolUse but there are no pi-known tool calls in content,
        // it means only user MCP tools were called (filtered by event bridge).
        // Override to "stop" so pi doesn't try to execute non-existent tools.
        const piToolCalls = (output.content || []).filter(
          (c: any) => c.type === "toolCall",
        );
        const effectiveReason =
          output.stopReason === "toolUse" && piToolCalls.length === 0
            ? "stop"
            : output.stopReason;

        streamEnded = true;
        stream.push({
          type: "done",
          reason:
            effectiveReason === "toolUse"
              ? "toolUse"
              : effectiveReason === "length"
                ? "length"
                : "stop",
          message: { ...output, stopReason: effectiveReason },
        });
        stream.end();
      }
    } catch (err: any) {
      stream.push({
        type: "error",
        reason: "error",
        error: err.message ?? "Unexpected error in streamViaCli",
      } as any);
      stream.end();
    } finally {
      // Clean up abort listener
      if (options?.signal && abortHandler) {
        options.signal.removeEventListener("abort", abortHandler);
      }
      cleanupSystemPromptFile();
    }
  })();

  return stream;
}
