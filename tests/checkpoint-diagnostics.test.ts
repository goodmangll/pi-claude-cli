import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  snapshotPrefix,
  reportMismatch,
  clearCheckpointDiagnostics,
  checkpointDebugEnabled,
} from "../src/checkpoint-diagnostics";

describe("checkpoint diagnostics", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearCheckpointDiagnostics();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    delete process.env.PI_CLAUDE_CLI_CHECKPOINT_DEBUG;
    clearCheckpointDiagnostics();
  });

  it("is disabled by default and does nothing", () => {
    delete process.env.PI_CLAUDE_CLI_CHECKPOINT_DEBUG;
    expect(checkpointDebugEnabled()).toBe(false);
    snapshotPrefix("s", 2, [{ role: "user", content: "a" }]);
    reportMismatch("s", [2], [{ role: "user", content: "b" }]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("names the drifting message index and field path on mismatch", () => {
    process.env.PI_CLAUDE_CLI_CHECKPOINT_DEBUG = "1";
    const savedPrefix = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "", thinkingSignature: "SIG-A" },
        ],
      },
    ];
    snapshotPrefix("s", 2, savedPrefix);

    // Same conversation, but the signature on message[1] drifted.
    const currentPrefix = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "", thinkingSignature: "SIG-B" },
        ],
      },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ];
    reportMismatch("s", [2], currentPrefix);

    expect(warn).toHaveBeenCalledOnce();
    const msg = warn.mock.calls[0][0] as string;
    expect(msg).toContain("message[1]");
    expect(msg).toContain("thinkingSignature");
    expect(msg).toContain("SIG-A");
    expect(msg).toContain("SIG-B");
  });

  it("flags an added field", () => {
    process.env.PI_CLAUDE_CLI_CHECKPOINT_DEBUG = "1";
    snapshotPrefix("s", 1, [{ role: "user", content: [{ type: "text" }] }]);
    reportMismatch(
      "s",
      [1],
      [{ role: "user", content: [{ type: "text", cache_control: {} }] }],
    );
    const msg = warn.mock.calls[0][0] as string;
    expect(msg).toContain("cache_control");
    expect(msg).toContain("added");
  });

  it("warns that the projection is identical when only unhashed fields differ", () => {
    process.env.PI_CLAUDE_CLI_CHECKPOINT_DEBUG = "1";
    // role/content/toolName are what the fingerprint hashes; a difference in a
    // non-hashed field (e.g. timestamp) leaves the projection identical.
    snapshotPrefix("s", 1, [{ role: "user", content: "hi", timestamp: "T1" }]);
    reportMismatch(
      "s",
      [1],
      [{ role: "user", content: "hi", timestamp: "T2" }],
    );
    const msg = warn.mock.calls[0][0] as string;
    expect(msg).toContain("byte-identical under projection");
  });

  it("does nothing when there is no snapshot for the session", () => {
    process.env.PI_CLAUDE_CLI_CHECKPOINT_DEBUG = "1";
    reportMismatch("never-seen", [3], [{ role: "user", content: "x" }]);
    expect(warn).not.toHaveBeenCalled();
  });
});
