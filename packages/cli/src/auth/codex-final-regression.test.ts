import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// Each child imports production AFTER HOME/config isolation. No parent singleton,
// vault, real config, or network survives into the exercise.
async function runChild(scenario: string) {
  const dir = mkdtempSync(join(tmpdir(), "claudish-codex-final-"));
  const base = pathToFileURL(`${import.meta.dir}/`).href;
  const source = `
    import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
    import { join } from "node:path";
    const path = join(process.env.HOME, ".claudish", "codex-oauth.json");
    const parent = join(process.env.HOME, ".claudish");
    mkdirSync(parent, {recursive:true});
    const mode = ${JSON.stringify(scenario)};
    // PROVISIONAL: replace token document/error responses with sanitized Phase V captures.
    const document = JSON.stringify({access_token:"oauth-access",refresh_token:"oauth-refresh",expires_at:Date.now()+3600000});
    if(mode !== "missing") writeFileSync(path, mode === "invalid" ? "{" : document);
    if(mode === "file-denied") chmodSync(path, 0);
    if(mode === "parent-denied") chmodSync(parent, 0);
    const {CodexOAuth} = await import(${JSON.stringify(`${base}codex-oauth.ts`)});
    const oauth = CodexOAuth.getInstance();
    if(mode === "transient") {
      oauth._setCredentialFileReaderForTests(() => {throw Object.assign(new Error("EMFILE"),{code:"EMFILE"});});
      oauth.reloadCredentials();
    }
    const {credentials} = await import(${JSON.stringify(`${base}credentials/authority.ts`)});
    const {makeCodexCredential} = await import(${JSON.stringify(`${base}credentials/codex-credential.ts`)});
    credentials.register(makeCodexCredential());
    const {OpenAICodexTransport} = await import(${JSON.stringify(`${base}../providers/transport/openai-codex.ts`)});
    const {ComposedHandler} = await import(${JSON.stringify(`${base}../handlers/composed-handler.ts`)});
    const {Hono} = await import("hono");
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({url:String(url),authorization:new Headers(init?.headers).get("authorization")});
      return new Response('data: [DONE]\\n\\n', {headers:{"content-type":"text/event-stream"}});
    };
    const transport = new OpenAICodexTransport({name:"openai-codex",baseUrl:"https://api.openai.com",apiPath:"/v1/responses",apiKeyEnvVar:"OPENAI_CODEX_API_KEY",prefixes:["cx@"]},"regression-model",process.env.OPENAI_CODEX_API_KEY);
    const handler = new ComposedHandler(transport,"regression-model","regression-model",8080,{});
    const app = new Hono();
    app.post("/", async c => handler.handle(c, await c.req.json()));
    const request = () => app.request("http://local.test/",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({model:"regression-model",max_tokens:16,stream:true,messages:[{role:"user",content:"hello"}]})});
    try {
      const first = await request();
      const body = await first.text();
      const firstCalls = calls.slice();
      let second;
      if(mode === "transient" || mode === "file-denied") {
        if(mode === "file-denied") chmodSync(path, 0o600);
        else oauth._setCredentialFileReaderForTests(null);
        const res = await request();
        second = {status:res.status,body:await res.text()};
      }
      console.log(JSON.stringify({status:first.status,verdict:first.headers.get("x-claudish-auth-verdict"),body,firstCalls,calls,second,path}));
    } finally {
      chmodSync(parent, 0o700);
      if(mode !== "missing") chmodSync(path,0o600);
    }
  `;
  try {
    const child = Bun.spawn([process.execPath, "--eval", source], {
      cwd: join(import.meta.dir, "../.."),
      env: {
        ...process.env,
        HOME: dir,
        CLAUDISH_CONFIG: join(dir, "config.json"),
        CLAUDISH_ACCOUNTS_DIR: join(dir, "accounts"),
        CLAUDISH_DISABLE_KEYCHAIN: "1",
        CLAUDISH_DISABLE_OP: "1",
        CLAUDISH_DISABLE_CATALOG_WARM: "1",
        OPENAI_CODEX_API_KEY: "sk-canary-must-never-be-used",
        CLAUDISH_TEST_UPSTREAM: undefined,
        CLAUDISH_ACCOUNTS_FAULT: undefined,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, stderr).toBe(0);
    return JSON.parse(stdout.trim()) as {
      status: number;
      verdict: string | null;
      body: string;
      firstCalls: Array<{ url: string; authorization: string }>;
      calls: Array<{ url: string; authorization: string }>;
      second?: { status: number };
      path: string;
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const scenario of ["invalid", "transient", "file-denied", "parent-denied"]) {
  test.skipIf(scenario.endsWith("denied") && process.getuid?.() === 0)(
    `V16b live request: ${scenario} never signs metered`,
    async () => {
      // Mutations: drop failed-file availability, restore existsSync absence (parent),
      // or remove the failed-read retry (transient and repaired chmod case).
      const result = await runChild(scenario);
      const body = JSON.parse(result.body);
      // A denied .claudish directory makes the registry's config stat fail first.
      const failurePath =
        scenario === "parent-denied" ? join(dirname(result.path), "config.json") : result.path;
      if (scenario === "transient") {
        // implementation-log.md § v14 merge fixes / M2: facade EMFILE is local.
        expect(result.status).toBe(503);
        expect(body.error.upstream_status).toBe(503);
        expect(result.verdict).toBe("transient");
        expect(body.error.message).toContain("claudish login codex");
      } else {
        expect(result.status).toBe(503);
        expect(body.error.upstream_status).toBe(503);
        expect(result.verdict).toBe("transient");
        expect(body.error.message).toContain(`Could not read the ${failurePath} account list`);
      }
      expect(body.error.message).toContain(failurePath);
      expect(result.firstCalls).toEqual([]);
      expect(JSON.stringify(result.calls)).not.toContain("sk-canary-must-never-be-used");
      if (scenario === "transient" || scenario === "file-denied") {
        expect(result.second?.status).toBe(200);
        expect(result.calls).toHaveLength(1);
        expect(result.calls[0]?.authorization).toBe("Bearer oauth-access");
      }
    }
  );
}

test("H2: gated legacy exchange aborts at ten seconds and classifies as unreachable", async () => {
  // Mutation: restore the 20-second bound, drop the signal, or wrap the timeout as terminal auth.
  const dir = mkdtempSync(join(tmpdir(), "claudish-codex-timeout-"));
  const base = pathToFileURL(`${import.meta.dir}/`).href;
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `
      import {mkdirSync,writeFileSync} from "node:fs";
      import {join} from "node:path";
      const parent=join(process.env.HOME,".claudish");
      mkdirSync(parent,{recursive:true});
      // PROVISIONAL: replace with a sanitized Phase V expired credential capture.
      writeFileSync(join(parent,"codex-oauth.json"),JSON.stringify({access_token:"a",refresh_token:"r",expires_at:1}));
      const {CodexOAuth}=await import(${JSON.stringify(`${base}codex-oauth.ts`)});
      const {classifyConnectionError}=await import(${JSON.stringify(`${base}../handlers/shared/connection-error.ts`)});
      let calls=0;
      globalThis.fetch=async (_url,init)=>{
        calls++;
        return await new Promise((resolve,reject)=>{
          if(!init.signal) throw new Error("missing timeout signal");
          init.signal.addEventListener("abort",()=>reject(init.signal.reason),{once:true});
        });
      };
      const started=performance.now();
      try {await CodexOAuth.getInstance().forceRefresh(); throw new Error("unexpected success");}
      catch(error){console.log(JSON.stringify({elapsed:performance.now()-started,calls,classified:classifyConnectionError(error),terminal:error.terminal,message:error.message,endpoint:error.claudishEndpoint}));}
    `,
      ],
      {
        cwd: join(import.meta.dir, "../.."),
        env: {
          ...process.env,
          HOME: dir,
          CLAUDISH_CONFIG: join(dir, "config.json"),
          CLAUDISH_ACCOUNTS_DIR: join(dir, "accounts"),
          CLAUDISH_DISABLE_KEYCHAIN: "1",
          CLAUDISH_DISABLE_OP: "1",
          CLAUDISH_TEST_UPSTREAM: "http://127.0.0.1:4567",
          CLAUDISH_ACCOUNTS_FAULT: undefined,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const watchdog = setTimeout(() => child.kill(), 24_000);
    try {
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exit, stderr).toBe(0);
      const result = JSON.parse(stdout.trim());
      expect(result.calls).toBe(1);
      expect(result.elapsed).toBeGreaterThanOrEqual(9_500);
      expect(result.elapsed).toBeLessThan(15_000);
      expect(result.classified).toBeTruthy();
      expect(result.terminal).not.toBe(true);
      expect(result.message).toContain("Could not reach");
      expect(result.endpoint).toContain("127.0.0.1:4567");
    } finally {
      clearTimeout(watchdog);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test("V16b missing file still uses the api-key half on the live path", async () => {
  // Mutation: treat ENOENT as a failed configured login, disabling api-key users.
  const result = await runChild("missing");
  expect(result.status).toBe(200);
  expect(result.calls).toHaveLength(1);
  expect(result.calls[0]?.authorization).toBe("Bearer sk-canary-must-never-be-used");
  expect(result.calls[0]?.url).toContain("api.openai.com");
});
