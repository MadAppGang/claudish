// Prints every change of the claudish agent rows in the check session, once per 500 ms, for N seconds.
const SOCK = "/Users/jack/.config/herdr/sessions/claudish-mtl399-check/herdr.sock";
const seconds = Number(process.argv[2] ?? 60);
let last = "";
const t0 = Date.now();
while (Date.now() - t0 < seconds * 1000) {
  const p = Bun.spawnSync(["/Users/jack/.local/bin/herdr", "agent", "list"], {
    env: { ...process.env, HERDR_SOCKET_PATH: SOCK },
  });
  const agents = JSON.parse(p.stdout.toString()).result.agents.filter(
    (a: { agent?: string }) => a.agent === "claudish"
  );
  const now = JSON.stringify(
    agents.map((a: any) => ({ pane: a.pane_id, status: a.agent_status, labels: a.state_labels, tokens: a.tokens }))
  );
  if (now !== last) {
    console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s ${now}`);
    last = now;
  }
  await Bun.sleep(500);
}
