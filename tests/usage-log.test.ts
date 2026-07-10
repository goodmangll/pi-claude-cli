import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneOldShards, todayShard } from "../src/usage-log";

describe("usage-log daily sharding", () => {
  it("names the shard by UTC date", () => {
    expect(todayShard(new Date("2026-07-11T23:59:00Z"))).toBe(
      "usage-2026-07-11.jsonl",
    );
    expect(todayShard(new Date("2026-01-01T00:00:00Z"))).toBe(
      "usage-2026-01-01.jsonl",
    );
  });
});

describe("usage-log retention prune", () => {
  let dir: string;
  const shard = (offsetDays: number): string => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + offsetDays);
    return todayShard(d);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-claude-cli-shards-"));
    delete process.env.PI_CLAUDE_CLI_USAGE_RETENTION_DAYS;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.PI_CLAUDE_CLI_USAGE_RETENTION_DAYS;
  });

  it("removes shards older than the retention window, keeps recent ones", () => {
    process.env.PI_CLAUDE_CLI_USAGE_RETENTION_DAYS = "30";
    const old = shard(-40);
    const recent = shard(-2);
    const today = shard(0);
    for (const f of [old, recent, today]) writeFileSync(join(dir, f), "{}\n");

    pruneOldShards(dir);

    const left = readdirSync(dir);
    expect(left).not.toContain(old);
    expect(left).toContain(recent);
    expect(left).toContain(today);
  });

  it("never touches non-shard files (safety scoping)", () => {
    process.env.PI_CLAUDE_CLI_USAGE_RETENTION_DAYS = "1";
    const foreign = [
      "usage.jsonl",
      "notes.txt",
      "usage-backup.jsonl",
      "config",
    ];
    for (const f of foreign) writeFileSync(join(dir, f), "keep me");
    writeFileSync(join(dir, shard(-40)), "{}\n"); // an old shard, should go

    pruneOldShards(dir);

    const left = readdirSync(dir);
    for (const f of foreign) expect(left).toContain(f);
    expect(left).not.toContain(shard(-40));
  });

  it("disables pruning when retention <= 0", () => {
    process.env.PI_CLAUDE_CLI_USAGE_RETENTION_DAYS = "0";
    const old = shard(-100);
    writeFileSync(join(dir, old), "{}\n");

    pruneOldShards(dir);

    expect(readdirSync(dir)).toContain(old);
  });
});
