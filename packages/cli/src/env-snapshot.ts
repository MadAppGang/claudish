/**
 * Side-effect module: snapshot environment variables that must never be
 * satisfiable from a cwd `.env`, BEFORE `index.ts` calls `dotenv.config()`.
 *
 * ES modules evaluate every import before the importing module's body runs,
 * and `index.ts` calls `config()` in its body, so importing this module from
 * `index.ts`'s import list is what makes the snapshot pre-dotenv.
 */
import { captureInheritedMuseEnv } from "./providers/meta-muse/muse-env-trust.js";

captureInheritedMuseEnv();
