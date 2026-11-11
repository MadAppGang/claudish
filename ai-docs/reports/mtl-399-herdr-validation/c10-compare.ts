// Mean per-test time, branch vs main, from the JUnit files c10-junit-<side>-<i>.xml.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const V = import.meta.dir;
const read = (side: string, i: number): Map<string, number> => {
  const xml = readFileSync(join(V, `c10-junit-${side}-${i}.xml`), "utf8");
  const m = new Map<string, number>();
  for (const t of xml.matchAll(/<testcase name="([^"]*)"[^>]*time="([0-9.]+)"/g))
    m.set(t[1] as string, Number(t[2]));
  return m;
};
const mean = (side: string) => {
  const runs = [read(side, 1), read(side, 2)];
  const out = new Map<string, number>();
  for (const k of runs[0]?.keys() ?? []) out.set(k, ((runs[0]?.get(k) ?? 0) + (runs[1]?.get(k) ?? 0)) / 2);
  return out;
};
for (const side of ["branch", "main"])
  for (const i of [1, 2]) {
    const xml = readFileSync(join(V, `c10-junit-${side}-${i}.xml`), "utf8");
    const sum = [...read(side, i).values()].reduce((a, x) => a + x, 0);
    console.log(`${side} ${i}: ${sum.toFixed(1)} s, failures ${(xml.match(/<failure/g) ?? []).length}`);
  }
const b = mean("branch");
const m = mean("main");
let tb = 0;
let tm = 0;
const rows: Array<[number, number, number, string]> = [];
for (const [k, vb] of b) {
  const vm = m.get(k) ?? 0;
  tb += vb;
  tm += vm;
  rows.push([vb - vm, vb, vm, k]);
}
rows.sort((x, y) => y[0] - x[0]);
console.log(`total branch ${tb.toFixed(1)} s, main ${tm.toFixed(1)} s`);
for (const [d, vb, vm, k] of rows.slice(0, 12))
  console.log(`${d >= 0 ? "+" : ""}${d.toFixed(2)}s  branch ${vb.toFixed(2)}  main ${vm.toFixed(2)}  ${k.slice(0, 90)}`);
console.log("...");
for (const [d, vb, vm, k] of rows.slice(-4))
  console.log(`${d >= 0 ? "+" : ""}${d.toFixed(2)}s  branch ${vb.toFixed(2)}  main ${vm.toFixed(2)}  ${k.slice(0, 90)}`);
