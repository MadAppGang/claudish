import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";

for (const raw of ["", " ", "\t\n\r "]) {
  test(`REQ-5 TEST-23 empty/whitespace ${JSON.stringify(raw)} returns null with no journal or observation`, async () => {
    const home = mkdtempSync(new URL("./.t1-home-", import.meta.url).pathname);
    try {
      // HOME must be inherited before Bun starts: changing process.env.HOME in-process does not isolate homedir().
      // Script inputs and the tool schema are structural test data, not captured protocol.
      const script = `
        import { existsSync } from "node:fs";
        import { BehaviorEngine } from ${JSON.stringify(new URL("./engine.ts", import.meta.url).pathname)};
        import { journalPath } from ${JSON.stringify(new URL("./journal.ts", import.meta.url).pathname)};
        let observed = 0;
        let network = 0;
        globalThis.fetch = async () => { network++; throw new Error("Network forbidden in T1"); };
        const engine = new BehaviorEngine({observer:{enabled:true, mode:"suggest", watchTools:["Write"]}}, [{
          id:"t1/empty-arguments", description:"observe repair input", defaultSeverity:"fix",
          appliesTo:()=>true, interceptsTools:["Write"], onToolCall:()=>{observed++;return [];}
        }]);
        const session = engine.startSession({modelId:"capture-model", providerName:"openai-codex", isNativeAnthropic:false});
        const result = session.repairToolCall("Write", ${JSON.stringify(raw)});
        for(let i=0;i<100;i++) await Promise.resolve();
        const path = journalPath();
        if(!path.startsWith(process.env.HOME + "/")) throw new Error("Journal escaped the isolated HOME");
        console.log(JSON.stringify({result,observed,network,journalExists:existsSync(path)}));
      `;
      const child = Bun.spawn([process.execPath, "-e", script], {
        env: { ...process.env, HOME: home, XDG_CONFIG_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(JSON.parse(stdout)).toEqual({
        result: null,
        observed: 0,
        network: 0,
        journalExists: false,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}
