import type { Credential } from "../credentials/types";
import type { CredentialState } from "./state";

export interface PickOptions {
  conversationId?: string;
  signal?: AbortSignal;
}

export interface Pool {
  pick(options?: PickOptions): Promise<Credential | null>;
  size(): number;
  getState?(uid: string): CredentialState;
  getStats?(): Record<CredentialState, number>;
  /** Feed an inference-time success back into health/breaker state. */
  reportSuccess?(uid: string): void;
  /** Feed an inference-time failure (upstream code) back into health/breaker state. */
  reportFailure?(uid: string, code: number | string): void;
}

export interface HardenedPool extends Pool {
  getState(uid: string): CredentialState;
  getStats(): Record<CredentialState, number>;
}
