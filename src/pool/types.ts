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
}

export interface HardenedPool extends Pool {
  getState(uid: string): CredentialState;
  getStats(): Record<CredentialState, number>;
}
