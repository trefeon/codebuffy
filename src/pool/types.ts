import type { Credential } from "../credentials/types";

export interface Pool {
  pick(): Promise<Credential | null>;
  size(): number;
}
