import { expect, test } from "bun:test";
import { isolatedFile } from "./test-helpers/claude-behaviour.js";
import { runProgram, useSandbox } from "./test-helpers/model-lineup-blind.js";

interface ModelsBody {
  object: string;
  has_more: boolean;
  data: Array<{
    id: string;
    object: string;
    type: string;
    created: number;
    owned_by: string;
    display_name?: string;
  }>;
}

await isolatedFile(import.meta, async () => {
  const sandbox = useSandbox();
  const proxyUrl = new URL("./proxy-server.js", import.meta.url).href;
  const lineupUrl = new URL("./launcher/model-lineup.js", import.meta.url).href;
  const common = [
    'import {mkdirSync, writeFileSync} from "node:fs";',
    'import {join} from "node:path";',
    "const requests = [];",
    'const credential = "blind-signing-value-" + crypto.randomUUID();',
    "let releaseUpstream = () => {};",
    "let arrived = () => {};",
    "let arrival = new Promise(resolve => { arrived = resolve; });",
    "let held = false;",
    "let permit = new Promise(resolve => { releaseUpstream = resolve; });",
    'const upstream = Bun.serve({hostname:"127.0.0.1",port:0, async fetch(request) {',
    "  const url = new URL(request.url);",
    '  if (request.method === "GET") return Response.json({object:"list",data:[]});',
    "  const body = await request.json();",
    "  requests.push({path:url.pathname, model:body.model});",
    "  arrived();",
    "  if (held) await permit;",
    "  if (body.stream) {",
    '    const chunk = (choices, usage) => ({id:"blind-response",object:"chat.completion.chunk",model:body.model,created:1716000000,choices,...(usage ? {usage} : {})});',
    "    const chunks = [",
    '      chunk([{index:0,delta:{role:"assistant",content:"reply-for-" + body.model},finish_reason:null}]),',
    '      chunk([{index:0,delta:{},finish_reason:"stop"}]),',
    "      chunk([],{prompt_tokens:3,completion_tokens:2,total_tokens:5}),",
    "    ];",
    '    const events = chunks.map((value) => "data: " + JSON.stringify(value) + "\\n\\n").join("") + "data: [DONE]\\n\\n";',
    '    return new Response(events,{headers:{"content-type":"text/event-stream"}});',
    "  }",
    '  return Response.json({id:"blind-response", object:"chat.completion", model:body.model, created:1716000000, choices:[{index:0,message:{role:"assistant",content:"reply-for-" + body.model},finish_reason:"stop"}],usage:{prompt_tokens:3,completion_tokens:2,total_tokens:5}});',
    "}});",
    'const declared = ["start","anthropic/claude-opus-test","user-choice","role-override","slot-override"];',
    'const config = {customEndpoints:{"blind-gw":{kind:"simple", url:"http://127.0.0.1:" + upstream.port + "/v1",format:"openai",apiKey:credential,models:declared}}};',
    'mkdirSync(join(process.env.HOME,".claudish"),{recursive:true});',
    'writeFileSync(join(process.env.HOME,".claudish","config.json"),JSON.stringify(config));',
    "writeFileSync(process.env.CLAUDISH_CONFIG,JSON.stringify(config));",
    "const {createProxyServer} = await import(" + JSON.stringify(proxyUrl) + ");",
    "let proxy;",
    'const listed = "blind-gw@anthropic/claude-opus-test";',
    'const user = "blind-gw@user-choice";',
    'const rows = [{model:listed,label:"Listed readable label"},{model:user,label:"User readable label"}];',
    "async function post(model) {",
    '  const response = await fetch(proxy.url + "/v1/messages",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({model,max_tokens:16,stream:false,messages:[{role:"user",content:"hello"}]})});',
    "  return {status:response.status,body:await response.json()};",
    "}",
    'async function models() {const r=await fetch(proxy.url+"/v1/models");return {status:r.status,body:await r.json()};}',
    "let resultLine;",
    'function emit(value) {resultLine = "@@result=" + JSON.stringify(value);}',
  ].join("\n");

  async function run<T>(source: string): Promise<T> {
    // Publish only after awaited cleanup; library background work cannot keep this eval child alive.
    const program = [
      common,
      "try {",
      source,
      'if (typeof resultLine !== "string") throw new Error("The test did not produce a result");',
      'await Bun.write(Bun.stdout, resultLine + "\\n");',
      "process.exit(0);",
      "} catch (error) {",
      "console.error(error);",
      "process.exit(1);",
      "}",
    ].join("\n");
    // Finish the child before the enclosing 20-second test deadline.
    const result = await runProgram(sandbox().home, ["--eval", program], {}, 15_000);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const line = result.stdout.split("\n").find((value) => value.startsWith("@@result="));
    expect(line, result.stdout + result.stderr).toBeDefined();
    return JSON.parse(line!.slice("@@result=".length)) as T;
  }

  // REQ-9, REQ-10: real HTTP verifies wire ids, including the role-substring collision.
  test("TEST-37 successive lineup and user picks route as picked before role/slot/fallback", async () => {
    const result = await run<{
      replies: Array<{ status: number; body: { content: Array<{ type: string; text: string }> } }>;
      requests: Array<{ model: string; path: string }>;
    }>(
      [
        "try {",
        '  proxy = await createProxyServer(0,undefined,"blind-gw@start",false,undefined,{opus:"blind-gw@role-override"},{quiet:true,hooks:false,modelLineup:rows,slotMap:new Map([[listed,{provider:"blind-gw",model:"slot-override"}]])});',
        "  const replies = [];",
        '  for (const model of [listed,user,"claude-opus-test","claude-sonnet-test"]) replies.push(await post(model));',
        "  emit({replies,requests});",
        "} finally {releaseUpstream(); if(proxy) await proxy.shutdown(); await upstream.stop(true);}",
      ].join("\n")
    );
    const expected = ["anthropic/claude-opus-test", "user-choice", "role-override", "start"];
    expect(result.requests.map((request) => request.model)).toEqual(expected);
    expect(result.replies.map((reply) => reply.status)).toEqual([200, 200, 200, 200]);
    result.replies.forEach((reply, i) => {
      expect(reply.body.content).toEqual(
        expect.arrayContaining([{ type: "text", text: "reply-for-" + expected[i] }])
      );
    });
  }, 20_000);

  // REQ-19
  test("TEST-38 models endpoint returns exactly ordered lineup and preserved user rows", async () => {
    const result = await run<{ status: number; body: ModelsBody }>(
      [
        'try {proxy=await createProxyServer(0,undefined,"blind-gw@start",false,undefined,undefined,{quiet:true,hooks:false,modelLineup:rows});emit(await models());}',
        "finally {if(proxy) await proxy.shutdown();await upstream.stop(true);}",
      ].join("\n")
    );
    expect(result).toEqual({
      status: 200,
      body: {
        object: "list",
        has_more: false,
        data: [
          {
            id: "blind-gw@anthropic/claude-opus-test",
            type: "model",
            object: "model",
            display_name: "Listed readable label",
            created: 1716000000,
            owned_by: "claudish",
          },
          {
            id: "blind-gw@user-choice",
            type: "model",
            object: "model",
            display_name: "User readable label",
            created: 1716000000,
            owned_by: "claudish",
          },
        ],
      },
    });
  }, 20_000);

  test("TEST-39 served slots override lineup rows and preserve their created timestamp", async () => {
    const result = await run<{ status: number; body: ModelsBody }>(
      [
        'try {proxy=await createProxyServer(0,undefined,undefined,false,undefined,undefined,{quiet:true,hooks:false,modelLineup:rows,servedSlotIds:["claude-opus-test","claude-sonnet-test"]});emit(await models());}',
        "finally {if(proxy) await proxy.shutdown();await upstream.stop(true);}",
      ].join("\n")
    );
    expect(result).toEqual({
      status: 200,
      body: {
        object: "list",
        has_more: false,
        data: [
          {
            id: "claude-opus-test",
            type: "model",
            object: "model",
            created: 1716000000,
            owned_by: "claudish",
          },
          {
            id: "claude-sonnet-test",
            type: "model",
            object: "model",
            created: 1716000000,
            owned_by: "claudish",
          },
        ],
      },
    });
  }, 20_000);

  test("TEST-40 ordinary declared-model discovery preserves created for every entry", async () => {
    const result = await run<{ status: number; body: ModelsBody }>(
      [
        "try {proxy=await createProxyServer(0,undefined,undefined,false,undefined,undefined,{quiet:true,hooks:false});emit(await models());}",
        "finally {if(proxy) await proxy.shutdown();await upstream.stop(true);}",
      ].join("\n")
    );
    expect(result.status).toBe(200);
    expect(result.body.data.map((row) => row.id)).toEqual([
      "start",
      "anthropic/claude-opus-test",
      "user-choice",
      "role-override",
      "slot-override",
    ]);
    expect(result.body.data.every((row) => row.created === 1716000000)).toBe(true);
    expect(result.body.data.length).toBeGreaterThan(0);
  }, 20_000);

  // REQ-19, REQ-31, REQ-44: the request is still in flight while GET redacts its label.
  test("TEST-41 model labels redact a value signed with after startup", async () => {
    const result = await run<{
      status: number;
      body: ModelsBody;
      secret: string;
      replyStatus: number;
      full: string;
      short: string;
      max: number;
    }>(
      [
        "let response;",
        "let timer;",
        "try {",
        '  const label = "Readable prefix " + credential + " suffix";',
        '  proxy = await createProxyServer(0,undefined,"blind-gw@start",false,undefined,undefined,{quiet:true,hooks:false,modelLineup:[{model:listed,label}]});',
        "  held = true;",
        "  response = post(listed);",
        '  await Promise.race([arrival,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("upstream request never arrived")),4000);})]);',
        "  clearTimeout(timer);",
        "  const discovery = await models();",
        "  const {redactAndTruncate} = await import(" + JSON.stringify(lineupUrl) + ");",
        '  const input = "prefix " + credential + " suffix";',
        "  const full = redactAndTruncate(input,1000);",
        "  const marker = full.slice(7,-7);",
        "  const max = 7 + Math.max(1,Math.floor(marker.length/2));",
        "  const short = redactAndTruncate(input,max);",
        "  releaseUpstream();",
        "  const reply = await response;",
        "  emit({...discovery,secret:credential,replyStatus:reply.status,full,short,max});",
        "} finally {clearTimeout(timer);releaseUpstream();if(response) await response.catch(()=>{});if(proxy) await proxy.shutdown();await upstream.stop(true);}",
      ].join("\n")
    );
    expect(result.status).toBe(200);
    expect(result.replyStatus).toBe(200);
    expect(result.body.data).toHaveLength(1);
    const label = result.body.data[0]!.display_name!;
    expect(label).toContain("Readable prefix");
    expect(label).toContain("suffix");
    expect(label).not.toContain(result.secret);
    expect(JSON.stringify(result.body)).not.toContain(result.secret);

    // REQ-31 / TEST-28: no assumptions about token patterns or marker spelling.
    expect(result.full).not.toContain(result.secret);
    expect(result.full.startsWith("prefix ")).toBe(true);
    expect(result.full.endsWith(" suffix")).toBe(true);
    expect(result.full.slice(7, -7).length).toBeGreaterThan(1);
    expect(result.short.length).toBeLessThanOrEqual(result.max);
    expect(result.short.endsWith("…")).toBe(true);
    expect(result.short.slice(0, -1).trimEnd()).toBe("prefix");
  }, 20_000);
});
