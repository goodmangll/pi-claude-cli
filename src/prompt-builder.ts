/**
 * Prompt builder for flattening pi conversation history into a labeled text prompt.
 *
 * Follows the reference project's buildPromptBlocks() pattern:
 * - USER: / ASSISTANT: / TOOL RESULT: labels
 * - Content blocks serialized by type
 * - Images in the final user message are translated to Anthropic API format (HIST-02)
 * - Images in non-final messages get placeholder text with console.warn
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";
import {
  mapPiToolNameToClaude,
  translatePiArgsToClaude,
  isCustomToolName,
} from "./tool-mapping.js";

/**
 * Anthropic API content block types for image passthrough.
 * Used when the final user message contains images that need to be
 * translated from pi-ai format to Anthropic format.
 */
type AnthropicContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    };

// We use `any` for Context to avoid requiring @mariozechner/pi-ai at dev time.
// At runtime, pi provides the real Context type.

/**
 * Flattens a pi conversation context's messages array into a labeled text prompt
 * suitable for sending to the Claude CLI subprocess.
 *
 * Each message is labeled with its role:
 * - USER: for user messages
 * - ASSISTANT: for assistant messages
 * - TOOL RESULT (historical {toolName}): for tool result messages
 */
/** Module-level counter for placeholder images, reset per buildPrompt call. */
let placeholderImageCount = 0;

/**
 * Translate a pi-ai image block to Anthropic API format.
 * Returns null if the block is missing required data/mimeType fields.
 *
 * pi-ai format:  { type: "image", data: string (base64), mimeType: string }
 * Anthropic format: { type: "image", source: { type: "base64", media_type: string, data: string } }
 */
function translateImageBlock(piBlock: any): AnthropicContentBlock | null {
  if (piBlock.data && piBlock.mimeType) {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: piBlock.mimeType,
        data: piBlock.data,
      },
    };
  }
  return null; // Invalid image block, will fall back to placeholder
}

/**
 * Build content blocks for the final user message, translating images
 * from pi-ai format to Anthropic API format.
 *
 * @returns Array of AnthropicContentBlock with text and translated images
 */
function buildFinalUserContent(
  content: string | any[],
): AnthropicContentBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) {
    return [{ type: "text", text: "" }];
  }

  const blocks: AnthropicContentBlock[] = [];
  for (const block of content) {
    if (block.type === "text") {
      blocks.push({ type: "text", text: block.text ?? "" });
    } else if (block.type === "image") {
      const translated = translateImageBlock(block);
      if (translated) {
        blocks.push(translated);
      } else {
        // Invalid image block: fall back to placeholder text
        blocks.push({
          type: "text",
          text: "[An image was shared here but could not be included]",
        });
        placeholderImageCount++;
      }
    }
    // Unknown block types silently skipped
  }
  return blocks;
}

/**
 * Check if a message content array contains image blocks.
 */
function contentHasImages(content: string | any[]): boolean {
  if (typeof content === "string" || !Array.isArray(content)) return false;
  return content.some((block) => block.type === "image");
}

/**
 * Check if the conversation ends with a custom tool result.
 * If so, build a simplified prompt that presents the result directly
 * instead of replaying the full conversation history with tool labels.
 */
function buildCustomToolResultPrompt(messages: any[]): string | null {
  if (messages.length < 3) return null;

  const last = messages[messages.length - 1];
  if (last.role !== "toolResult") return null;
  if (!last.toolName || !isCustomToolName(last.toolName)) return null;

  // Find the original user message (scan backwards past assistant + toolResult)
  let userMessage: string | null = null;
  for (let i = messages.length - 3; i >= 0; i--) {
    if (messages[i].role === "user") {
      userMessage = userContentToText(messages[i].content);
      break;
    }
  }
  if (!userMessage) return null;

  const toolResult = toolResultContentToText(last.content);
  return `${userMessage}\n\n[The ${last.toolName} tool was called and returned the following result]\n${toolResult}\n\nRespond to the user using the tool result above.`;
}

/**
 * Index where the "new content since the last turn" begins for a resumed
 * session: the final user message, walked back over the run of toolResult
 * messages immediately preceding it. Everything before this index is history
 * the CLI session is assumed to already contain.
 *
 * Exported so the provider's resume-consistency guard can reason about the
 * exact same delta boundary that buildResumePrompt sends.
 */
export function resumeDeltaStartIndex(messages: any[]): number {
  const finalUserIndex = findFinalUserMessageIndex(messages);
  if (finalUserIndex < 0) return messages.length;
  let startIdx = finalUserIndex;
  for (let i = finalUserIndex - 1; i >= 0; i--) {
    if (messages[i].role === "toolResult") {
      startIdx = i;
    } else {
      break;
    }
  }
  return startIdx;
}

/**
 * Label for a tool-result message:
 *   custom tool   -> "TOOL RESULT (deploy):"
 *   built-in tool -> "TOOL RESULT (historical Read):"
 */
function toolResultLabel(message: any): string {
  if (message.toolName && isCustomToolName(message.toolName)) {
    return `TOOL RESULT (${message.toolName}):`;
  }
  const claudeToolName = message.toolName
    ? mapPiToolNameToClaude(message.toolName)
    : "unknown";
  return `TOOL RESULT (historical ${claudeToolName}):`;
}

/**
 * Core serializer shared by buildPrompt (full history) and buildResumePrompt
 * (resume delta). Having a single implementation is what keeps the two paths
 * from drifting — image passthrough used to live only in buildPrompt, so the
 * resume path silently dropped tool-result images (e.g. `read` of a PNG).
 *
 * The three image rules are applied uniformly here:
 *   - final user message images -> passed through as Anthropic image blocks
 *   - tool result images        -> passed through
 *   - non-final user images     -> placeholder text (avoids replaying the
 *                                  whole image history into every prompt)
 *
 * Returns a plain string when nothing needs passthrough, otherwise a
 * ContentBlock[]. `labeled` controls the "USER:" / "ASSISTANT:" prefixes:
 * true for the full prompt, false for the resume delta (the CLI session
 * already holds the labeled history, so the delta is unlabeled new content).
 *
 * Resets and reports the module-level placeholder image counter.
 */
function serializeMessages(
  messages: any[],
  opts: { labeled: boolean },
): string | AnthropicContentBlock[] {
  placeholderImageCount = 0;
  const { labeled } = opts;

  const finalUserIndex = findFinalUserMessageIndex(messages);
  const finalUserHasImages =
    finalUserIndex >= 0 && contentHasImages(messages[finalUserIndex].content);
  const anyToolResultHasImages = messages.some(
    (m: any) => m.role === "toolResult" && toolResultHasImages(m.content),
  );
  const needsBlocks = finalUserHasImages || anyToolResultHasImages;

  const historyParts: string[] = [];
  const toolResultImageBlocks: AnthropicContentBlock[] = [];

  for (let i = 0; i < messages.length; i++) {
    // In the blocks path the final user message is emitted separately (as its
    // own content blocks) so it can carry images; skip it here. In the pure
    // text path it is serialized inline like any other message.
    if (needsBlocks && i === finalUserIndex) continue;
    const message = messages[i];
    if (message.role === "user") {
      if (labeled) historyParts.push("USER:");
      historyParts.push(userContentToText(message.content));
    } else if (message.role === "assistant") {
      if (labeled) historyParts.push("ASSISTANT:");
      historyParts.push(contentToText(message.content));
    } else if (message.role === "toolResult") {
      historyParts.push(toolResultLabel(message));
      historyParts.push(toolResultContentToText(message.content));
      if (needsBlocks && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type === "image") {
            const translated = translateImageBlock(block);
            if (translated) {
              toolResultImageBlocks.push(translated);
              // Undo the placeholder counted by toolResultContentToText — the
              // image is being passed through, not dropped.
              placeholderImageCount--;
            }
          }
        }
      }
    }
  }

  let result: string | AnthropicContentBlock[];
  if (needsBlocks) {
    const blocks: AnthropicContentBlock[] = [];
    const historyText = historyParts.join("\n");
    if (historyText) blocks.push({ type: "text", text: historyText });
    blocks.push(...toolResultImageBlocks);
    if (finalUserIndex >= 0) {
      blocks.push(...buildFinalUserContent(messages[finalUserIndex].content));
    }
    result = blocks;
  } else {
    result = historyParts.join("\n") || "";
  }

  if (placeholderImageCount > 0) {
    console.warn(
      `[pi-claude-cli] ${placeholderImageCount} image(s) in conversation history could not be included in the prompt`,
    );
  }
  return result;
}

/**
 * Build a prompt for a resumed session. The CLI already holds the full
 * labeled history, so this sends only the delta since the last turn: the run
 * of tool results preceding the final user message, plus that user message.
 * Delegates serialization (incl. image passthrough) to serializeMessages.
 */
export function buildResumePrompt(context: {
  messages: any[];
}): string | AnthropicContentBlock[] {
  const messages = context.messages;
  if (messages.length === 0) return "";

  // Find the last user message
  const finalUserIndex = findFinalUserMessageIndex(messages);
  if (finalUserIndex < 0) return "";

  // Resume delta = the final user message plus the run of tool-result messages
  // immediately preceding it (the CLI session already holds everything before
  // that). resumeDeltaStartIndex is the shared boundary the provider's
  // resume-consistency guard reasons about, so use it here too.
  const delta = messages.slice(resumeDeltaStartIndex(messages));

  // Unlabeled: the CLI already has the labeled history; the delta is just the
  // new content since the last turn.
  return serializeMessages(delta, { labeled: false });
}

export function buildPrompt(context: {
  messages: any[];
}): string | AnthropicContentBlock[] {
  // Reset placeholder counter for each call
  placeholderImageCount = 0;

  // Special case: when conversation ends with a custom tool result,
  // present it directly instead of complex history replay
  const customToolPrompt = buildCustomToolResultPrompt(context.messages);
  if (customToolPrompt) {
    // customToolPrompt calls userContentToText which may increment placeholderImageCount
    if (placeholderImageCount > 0) {
      console.warn(
        `[pi-claude-cli] ${placeholderImageCount} image(s) in conversation history could not be included in the prompt`,
      );
    }
    return customToolPrompt;
  }

  // Full history, labeled with USER: / ASSISTANT: / TOOL RESULT: prefixes.
  return serializeMessages(context.messages, { labeled: true });
}

/**
 * Find the index of the last user message in the messages array.
 * Returns -1 if no user message found.
 */
function findFinalUserMessageIndex(messages: any[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return i;
  }
  return -1;
}

/**
 * Builds the system prompt from the context's systemPrompt field,
 * appending AGENTS.md content if found (walking up from cwd, then global fallback).
 * Sanitizes .pi references to .claude for Claude Code compatibility.
 */
export function buildSystemPrompt(
  context: { systemPrompt?: string; messages: any[] },
  cwd: string,
): string {
  const parts: string[] = [];

  if (context.systemPrompt) {
    parts.push(context.systemPrompt);
  }

  // Look for AGENTS.md
  const agentsPath = resolveAgentsMdPath(cwd);
  if (agentsPath) {
    try {
      const content = readFileSync(agentsPath, "utf-8");
      const sanitized = sanitizeAgentsContent(content);
      parts.push(sanitized);
    } catch {
      // If we can't read it, skip silently
    }
  }

  // When conversation history has tool results, instruct Claude to use them
  // instead of trying to re-call tools (which may not be available).
  if (context.messages?.some((m: any) => m.role === "toolResult")) {
    parts.push(
      "IMPORTANT: The conversation history below contains tool results from previously executed tools. " +
        "Use these results to answer the user's question. Do NOT attempt to re-call tools that already have results.",
    );
  }

  return parts.join("\n\n");
}

/**
 * Converts user message content to text.
 * Handles string content and array of content blocks.
 * Image blocks are replaced with placeholder text (HIST-02).
 * Increments the module-level placeholderImageCount for each image.
 */
function userContentToText(content: string | any[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const texts: string[] = [];
  for (const block of content) {
    if (block.type === "text") {
      texts.push(block.text ?? "");
    } else if (block.type === "image") {
      texts.push("[An image was shared here but could not be included]");
      placeholderImageCount++;
    }
    // Unknown block types silently skipped
  }
  return texts.join("\n");
}

/**
 * Converts assistant message content to text.
 * Handles string content and array of content blocks (text, thinking, toolCall).
 */
function contentToText(content: string | any[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block) => {
      if (block.type === "text") return block.text ?? "";
      if (block.type === "thinking") return ""; // Skip thinking — internal reasoning, not conversation
      if (block.type === "toolCall") {
        const isCustom = isCustomToolName(block.name);
        if (isCustom) {
          // Custom tools: don't reference the MCP tool name — Claude might try to re-call it.
          // Just note what was done. The result follows as a TOOL RESULT message.
          const argsStr = block.arguments
            ? JSON.stringify(block.arguments)
            : "{}";
          return `[Used ${block.name} tool with args: ${argsStr}]`;
        }
        const claudeName = mapPiToolNameToClaude(block.name);
        const claudeArgs =
          block.arguments && typeof block.arguments === "object"
            ? translatePiArgsToClaude(
                block.name,
                block.arguments as Record<string, unknown>,
              )
            : block.arguments;
        const argsStr = claudeArgs ? JSON.stringify(claudeArgs) : "{}";
        return `Historical tool call (non-executable): ${claudeName} args=${argsStr}`;
      }
      // Unknown block types are represented as a placeholder
      return `[${block.type}]`;
    })
    .join("\n");
}

/**
 * Converts tool result content to text.
 * Handles string content and array of content blocks.
 * Image blocks get placeholder text (actual image passthrough handled separately).
 */
function toolResultContentToText(content: string | any[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const texts: string[] = [];
  for (const block of content) {
    if (block.type === "text") {
      texts.push(block.text ?? "");
    } else if (block.type === "image") {
      texts.push("[An image was shared here but could not be included]");
      placeholderImageCount++;
    }
  }
  return texts.join("\n");
}

/**
 * Check if a tool result content array contains image blocks.
 */
function toolResultHasImages(content: string | any[]): boolean {
  if (typeof content === "string" || !Array.isArray(content)) return false;
  return content.some((block) => block.type === "image");
}

/**
 * Walk up from cwd looking for AGENTS.md, fall back to ~/.pi/agent/AGENTS.md.
 */
function resolveAgentsMdPath(cwd: string): string | undefined {
  let current = resolve(cwd);
  while (true) {
    const candidate = join(current, "AGENTS.md");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  // Fall back to global path
  const globalPath = join(homedir(), ".pi", "agent", "AGENTS.md");
  if (existsSync(globalPath)) return globalPath;

  return undefined;
}

/**
 * Sanitize .pi references to .claude in AGENTS.md content
 * for Claude Code compatibility.
 */
function sanitizeAgentsContent(content: string): string {
  let sanitized = content;
  // ~/.pi -> ~/.claude
  sanitized = sanitized.replace(/~\/\.pi\b/gi, "~/.claude");
  // .pi/ -> .claude/ (at word boundary or after whitespace/quotes)
  sanitized = sanitized.replace(/(^|[\s'"`])\.pi\//g, "$1.claude/");
  // Remaining standalone .pi references
  sanitized = sanitized.replace(/\b\.pi\b/gi, ".claude");
  return sanitized;
}
