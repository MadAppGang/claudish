// REGRESSION: team voters in a ps-less sandbox lose their launch dir; proxied pane child hits the API-key dialog — Fixed in /dev:fix session dev-fix-20261021-011007-a7c3

import { sweepOrphanPanes } from "../pane-registry.js";
import { readProcessTable } from "../process-identity.js";

const root = process.argv[2];
if (!root) throw new Error("Expected a temporary pane root argument");

const processTableRows = readProcessTable().length;
const result = await sweepOrphanPanes(root);
process.stdout.write(`${JSON.stringify({ processTableRows, result })}\n`);
