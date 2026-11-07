import { spawnSync } from "node:child_process";
const r = spawnSync("bash", ["-n", "deploy.sh"], { encoding: "utf8" });
console.log(r.status === 0 ? "BASH-N-OK" : "BASH-N-FAIL " + (r.stderr || "").trim());
process.exitCode = r.status === 0 ? 0 : 1;
