/**
 * Global vitest setup: isolate checkpoint persistence from the real
 * filesystem. Without this, any test that exercises a successful streamViaCli
 * turn (most of provider.test.ts) writes real files to the user's actual
 * ~/.pi/claude-cli/checkpoints/ directory, since checkpoint persistence is
 * on by default. Point it at a per-run tmpdir instead so test runs never
 * touch the developer's real home directory.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "pi-claude-cli-test-checkpoints-"));
process.env.PI_CLAUDE_CLI_CHECKPOINT_DIR = dir;

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
