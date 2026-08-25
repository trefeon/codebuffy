import fs from "node:fs/promises";
import path from "node:path";
import { normalizePoolFile } from "./types";
import type { Credential } from "./types";
import type { Logger } from "../logger";

export interface ImportStore {
  upsert(cred: Credential): void | Promise<void>;
}

/**
 * Scans `poolDir` for `*.json` files, normalizes each via `normalizePoolFile`,
 * and upserts into `store`. Per-file failures (read / parse / normalize /
 * upsert) are counted as `skipped` and a warning is emitted via logger when
 * provided — one bad file never aborts the batch.
 */
export async function importPoolDir(
  poolDir: string,
  store: ImportStore,
  logger?: Pick<Logger, "warn">,
): Promise<{ imported: number; skipped: number }> {
  let entries: string[];
  try {
    entries = await fs.readdir(poolDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { imported: 0, skipped: 0 };
    throw err;
  }

  const jsonFiles = entries.filter((f) => f.endsWith(".json"));
  let imported = 0;
  let skipped = 0;

  for (const file of jsonFiles) {
    const fullPath = path.join(poolDir, file);
    try {
      const text = await fs.readFile(fullPath, "utf8");
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch (parseErr) {
        logger?.warn({ file, err: (parseErr as Error).message }, "importPoolDir: skipping file — invalid JSON");
        skipped++;
        continue;
      }

      let cred: Credential;
      try {
        cred = normalizePoolFile(raw);
      } catch (normErr) {
        logger?.warn({ file, err: (normErr as Error).message }, "importPoolDir: skipping file — normalize failed");
        skipped++;
        continue;
      }

      await store.upsert(cred);
      imported++;
    } catch (err) {
      logger?.warn({ file, err: (err as Error).message }, "importPoolDir: skipping file");
      skipped++;
    }
  }

  return { imported, skipped };
}
