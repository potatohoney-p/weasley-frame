import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";

const cli = join(process.cwd(), "bin", "weasley-frame.mjs");

test("CLI prints branded help", () => {
  const result = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Weasley Frame 1\.0\.0/);
  assert.match(result.stdout, /WEASLEY_FRAME_HOME/);
});

test("CLI prints version", () => {
  const result = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "1.0.0");
});

test("unknown commands fail safely", () => {
  const result = spawnSync(process.execPath, [cli, "not-a-command"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown command/);
});
