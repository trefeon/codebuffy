#!/usr/bin/env node
// Test runner: `bun test <pattern>` filters by substring over the whole path,
// so vendored repos under reference/ shipping their own *.test.ts get swept in.
// Running bun from inside test/ scopes discovery to exactly this directory.
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const testDir = join(here, "..", "test");
const count = readdirSync(testDir).filter((f) => /\.(test|spec)\.ts$/.test(f)).length;
if (count === 0) {
  console.error("no test files found in test/");
  process.exit(1);
}

const res = spawnSync("bun", ["test"], { stdio: "inherit", cwd: testDir });
process.exit(res.status ?? 1);
