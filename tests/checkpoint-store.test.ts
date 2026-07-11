import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  utimesSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadCheckpoints,
  saveCheckpoints,
  cliSessionExists,
  pruneOldCheckpoints,
} from "../src/checkpoint-store";

describe("checkpoint-store persistence", () => {
  let dir: string;
  // tests/setup.ts points this at a shared tmpdir for the whole run; restore
  // it (rather than deleting) so tests after this file don't fall through to
  // the real ~/.pi/claude-cli/checkpoints/.
  const originalCheckpointDir = process.env.PI_CLAUDE_CLI_CHECKPOINT_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-claude-cli-ckptstore-"));
    process.env.PI_CLAUDE_CLI_CHECKPOINT_DIR = dir;
    delete process.env.PI_CLAUDE_CLI_PERSIST_CHECKPOINTS;
    delete process.env.PI_CLAUDE_CLI_CHECKPOINT_RETENTION_DAYS;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.env.PI_CLAUDE_CLI_CHECKPOINT_DIR = originalCheckpointDir;
  });

  it("returns undefined when nothing has been saved yet", () => {
    expect(loadCheckpoints("no-such-session")).toBeUndefined();
  });

  it("round-trips checkpoints through save and load", () => {
    const entries = [
      { turnCount: 1, prefixHash: "hash1", cliSessionId: "cli-a" },
      { turnCount: 3, prefixHash: "hash3", cliSessionId: "cli-b" },
    ];
    saveCheckpoints("sess-1", entries);
    expect(loadCheckpoints("sess-1")).toEqual(entries);
  });

  it("overwrites the previous save for the same session id", () => {
    saveCheckpoints("sess-1", [
      { turnCount: 1, prefixHash: "h1", cliSessionId: "a" },
    ]);
    saveCheckpoints("sess-1", [
      { turnCount: 5, prefixHash: "h5", cliSessionId: "z" },
    ]);
    expect(loadCheckpoints("sess-1")).toEqual([
      { turnCount: 5, prefixHash: "h5", cliSessionId: "z" },
    ]);
  });

  it("sanitizes the session id so it cannot escape the checkpoint directory", () => {
    saveCheckpoints("../../etc/passwd", [
      { turnCount: 1, prefixHash: "h", cliSessionId: "a" },
    ]);
    // Written safely inside `dir` under a sanitized filename, not outside it.
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain("..");
  });

  it("is a no-op (does not throw, does not write) when disabled", () => {
    process.env.PI_CLAUDE_CLI_PERSIST_CHECKPOINTS = "0";
    saveCheckpoints("sess-1", [
      { turnCount: 1, prefixHash: "h", cliSessionId: "a" },
    ]);
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it("does not throw when the checkpoint file is corrupt JSON", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "sess-1.json"), "{not json", "utf8");
    expect(loadCheckpoints("sess-1")).toBeUndefined();
  });

  it("drops malformed entries but keeps well-formed ones", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "sess-1.json"),
      JSON.stringify({
        checkpoints: [
          { turnCount: 1, prefixHash: "h1", cliSessionId: "a" },
          { turnCount: "not-a-number", prefixHash: "h2", cliSessionId: "b" },
          { missing: "fields" },
        ],
      }),
      "utf8",
    );
    expect(loadCheckpoints("sess-1")).toEqual([
      { turnCount: 1, prefixHash: "h1", cliSessionId: "a" },
    ]);
  });
});

describe("cliSessionExists", () => {
  let claudeDir: string;
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;

  beforeEach(() => {
    claudeDir = mkdtempSync(join(tmpdir(), "pi-claude-cli-claudedir-"));
    process.env.CLAUDE_CONFIG_DIR = claudeDir;
  });
  afterEach(() => {
    rmSync(claudeDir, { recursive: true, force: true });
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    }
  });

  it("returns false when the projects directory doesn't exist at all", () => {
    expect(cliSessionExists("some-session-id")).toBe(false);
  });

  it("returns false when no project directory has a matching transcript", () => {
    mkdirSync(join(claudeDir, "projects", "-some-project"), {
      recursive: true,
    });
    expect(cliSessionExists("missing-session-id")).toBe(false);
  });

  it("returns true when a transcript file exists under any project directory", () => {
    const projectDir = join(claudeDir, "projects", "-Users-me-project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "abc-123.jsonl"), "", "utf8");
    expect(cliSessionExists("abc-123")).toBe(true);
  });

  it("finds the transcript regardless of which project directory it lives under", () => {
    mkdirSync(join(claudeDir, "projects", "-other-project"), {
      recursive: true,
    });
    const matchingDir = join(claudeDir, "projects", "-Users-me-project-b");
    mkdirSync(matchingDir, { recursive: true });
    writeFileSync(join(matchingDir, "xyz-789.jsonl"), "", "utf8");
    expect(cliSessionExists("xyz-789")).toBe(true);
  });
});

describe("pruneOldCheckpoints", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-claude-cli-ckptprune-"));
    delete process.env.PI_CLAUDE_CLI_CHECKPOINT_RETENTION_DAYS;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.PI_CLAUDE_CLI_CHECKPOINT_RETENTION_DAYS;
  });

  function fileAgedDays(name: string, ageDays: number): void {
    const path = join(dir, name);
    writeFileSync(path, "{}", "utf8");
    const past = new Date();
    past.setUTCDate(past.getUTCDate() - ageDays);
    utimesSync(path, past, past);
  }

  it("removes files older than the retention window, keeps recent ones", () => {
    process.env.PI_CLAUDE_CLI_CHECKPOINT_RETENTION_DAYS = "30";
    fileAgedDays("old.json", 40);
    fileAgedDays("recent.json", 2);

    pruneOldCheckpoints(dir);

    const left = readdirSync(dir);
    expect(left).not.toContain("old.json");
    expect(left).toContain("recent.json");
  });

  it("never touches non-.json files", () => {
    process.env.PI_CLAUDE_CLI_CHECKPOINT_RETENTION_DAYS = "1";
    fileAgedDays("notes.txt", 100);
    fileAgedDays("old.json", 100);

    pruneOldCheckpoints(dir);

    const left = readdirSync(dir);
    expect(left).toContain("notes.txt");
    expect(left).not.toContain("old.json");
  });

  it("disables pruning when retention <= 0", () => {
    process.env.PI_CLAUDE_CLI_CHECKPOINT_RETENTION_DAYS = "0";
    fileAgedDays("old.json", 400);

    pruneOldCheckpoints(dir);

    expect(readdirSync(dir)).toContain("old.json");
  });
});
