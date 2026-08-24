import type { SqliteCredentialStore } from "../credentials/store";
import type { RefreshService } from "../credentials/refresh";
import type { Logger } from "../logger";
import type { Pool } from "./types";
import type { Credential } from "../credentials/types";

export class RoundRobinPool implements Pool {
  private idx = 0;

  constructor(
    private readonly store: SqliteCredentialStore,
    private readonly refresh: RefreshService,
    private readonly logger: Logger,
  ) {}

  async pick(): Promise<Credential | null> {
    const list = this.store.list();
    const len = list.length;
    if (len === 0) return null;

    // Loop at most len times to try each credential once.
    for (let attempts = 0; attempts < len; attempts++) {
      // Wrap safely even if idx grew large.
      const candidate = list[this.idx % len];
      // Advance idx for next call regardless of outcome (task spec).
      this.idx = (this.idx + 1) % Number.MAX_SAFE_INTEGER;
      if (!candidate) continue;

      try {
        const fresh = await this.refresh.ensureFresh(candidate.uid);
        return fresh;
      } catch (err) {
        this.logger.warn({ uid: candidate.uid, err }, "pool skip failed refresh");
        continue;
      }
    }

    return null;
  }

  size(): number {
    return this.store.list().length;
  }
}
