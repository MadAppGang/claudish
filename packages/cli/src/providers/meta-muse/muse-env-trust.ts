/**
 * The two Muse Code host variables as the process INHERITED them, before
 * `index.ts` loads a `.env` from the current directory.
 *
 * `MUSE_CODE_BASE_URL` decides where the Muse Code login is sent, and
 * `CLAUDISH_MUSE_CODE_ALLOW_CUSTOM_HOST` permits a host other than
 * api.meta.ai. If either could come from a cwd `.env`, a cloned repository
 * could ship both and redirect the login. So `museTrustedBaseUrl` honours the
 * opt-in only from this snapshot, and refuses a non-Meta base URL that the
 * snapshot does not carry (it came from `.env`).
 *
 * Captured by an explicit call that `index.ts` makes from its import list,
 * which ES modules evaluate before the module body calls `dotenv.config()`.
 * When nothing captured it, the snapshot is unknown and the opt-in is
 * unavailable: the safe answer.
 */

export interface InheritedMuseEnv {
  baseUrl: string | undefined;
  allowCustomHost: string | undefined;
}

let snapshot: InheritedMuseEnv | null = null;

/** Record the inherited values. Only the first call counts. */
export function captureInheritedMuseEnv(
  env: Record<string, string | undefined> = process.env
): void {
  if (snapshot) return;
  snapshot = {
    baseUrl: env.MUSE_CODE_BASE_URL,
    allowCustomHost: env.CLAUDISH_MUSE_CODE_ALLOW_CUSTOM_HOST,
  };
}

/** The inherited values, or null when nothing captured them. */
export function inheritedMuseEnv(): InheritedMuseEnv | null {
  return snapshot;
}

/** Test seam: forget the snapshot. */
export function _resetInheritedMuseEnvForTest(): void {
  snapshot = null;
}
