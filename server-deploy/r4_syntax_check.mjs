import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
const files = readdirSync(process.cwd()).filter((f) => f.endsWith(".mjs"));
let bad = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
  if (r.status !== 0) { console.log("SYNTAX-FAIL " + f); bad++; }
}
console.log(bad === 0 ? "SYNTAX-ALL-OK files=" + files.length : "SYNTAX-ALL-FAIL bad=" + bad);
process.exitCode = bad === 0 ? 0 : 1;
