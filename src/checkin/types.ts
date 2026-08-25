import type { Credential } from "../credentials/types.js";

/**
 * Extended credential shape with optional check-in flag.
 * Stored as JSON inside the credentials table; the flag round-trips
 * through SqliteCredentialStore because it serialises the full object.
 *
 * This type is not yet merged into src/credentials/types.ts — that
 * change is proposed in local://checkin-patch.md. Until the integration
 * lands, helpers in this module read the flag via a safe cast.
 */
export type CheckinCredential = Credential & {
  checkinEnabled?: boolean;
};

/**
 * Returns true only when both the global kill-switch is on and the
 * per-credential flag is explicitly `true`.
 *
 * - globalFlag: value of CODEBUFFY_CHECKIN_ENABLED (default false)
 * - per-credential default: false (missing / falsy == disabled)
 */
export function isCheckinEnabled(
  cred: Credential,
  globalFlag: boolean,
): boolean {
  if (!globalFlag) return false;
  const c = cred as CheckinCredential;
  return c.checkinEnabled === true;
}
