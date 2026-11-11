// Calls, against the herdr check session, the same methods the placer uses, and prints each answer
// or error code: tab.list, layout.apply (scratch tab), tab.rename, pane.close.
import { HerdrSocket } from "../../../../packages/cli/src/herdr/herdr-socket.ts";

const sock = new HerdrSocket("/Users/jack/.config/herdr/sessions/claudish-mtl399-check/herdr.sock");
const show = async (name: string, method: string, params: Record<string, unknown>) => {
  try {
    const r = await sock.request(method, params);
    console.log(`${name}: OK ${JSON.stringify(r).slice(0, 400)}`);
    return r as Record<string, any>;
  } catch (e: any) {
    console.log(`${name}: ERROR ${e?.constructor?.name} code=${e?.code} ${e?.message}`);
    return null;
  }
};

await show("tab.list", "tab.list", { workspace_id: "w1" });
const applied = await show("layout.apply", "layout.apply", {
  workspace_id: "w1",
  tab_label: "claudish-new-probe",
  focus: false,
  root: { type: "pane", label: "probe", cwd: "/tmp", command: ["/bin/sleep", "60"], env: {} },
});
const tabId = applied?.layout?.tab_id;
const paneId = applied?.layout?.focused_pane_id;
console.log(`created tab=${tabId} pane=${paneId}`);
if (tabId) await show("tab.rename", "tab.rename", { tab_id: tabId, label: "claudish" });
await show("tab.list again", "tab.list", { workspace_id: "w1" });
if (paneId) await show("pane.close", "pane.close", { pane_id: paneId });
sock.close?.();
process.exit(0);
