// Does herdr 0.9.5 answer more than one request on one socket connection?
import { connect } from "node:net";

const s = connect("/Users/jack/.config/herdr/sessions/claudish-mtl399-check/herdr.sock");
s.setEncoding("utf8");
const t0 = Date.now();
s.on("data", (d) => console.log(`+${Date.now() - t0}ms data: ${String(d).trim().slice(0, 120)}`));
s.on("close", () => console.log(`+${Date.now() - t0}ms close`));
s.on("connect", () => {
  s.write(`${JSON.stringify({ id: "a", method: "tab.list", params: { workspace_id: "w1" } })}\n`);
  setTimeout(
    () => s.write(`${JSON.stringify({ id: "b", method: "tab.list", params: { workspace_id: "w1" } })}\n`),
    300
  );
});
setTimeout(() => process.exit(0), 1500);
