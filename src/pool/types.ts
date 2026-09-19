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
  /**
   * G6 admission control (RoundRobinPool implements it). Optional so existing
   * stub pools keep compiling; routes must use ?. chaining and treat a
   * missing gate as "admit". Releasing without acquiring is a no-op.
   */
  acquireAdmission?(signal?: AbortSignal): Promise<void>;
  releaseAdmission?(): void;
}

export interface HardenedPool extends Pool {
  getState(uid: string): CredentialState;
  getStats(): Record<CredentialState, number>;
}
