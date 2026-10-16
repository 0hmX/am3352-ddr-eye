import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { repeatEntry } from "../../packages/pcb-spice-pipeline/src/repeat.mjs"
import { runtimePaths } from "../../packages/pcb-spice-pipeline/src/runtime.mjs"
import { auditRun } from "../../scripts/verification/audit-general.mjs"

const project = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const output = resolve(process.argv[2] ?? join(project, "dist", `ddr-dq-${Date.now()}`))
process.chdir(project)
const runtime = await runtimePaths({ projectDir: project })
await repeatEntry("examples/ddr-dq/index.circuit.tsx", output)
const audits = []
for (const name of ["run-a", "run-b"]) audits.push(await auditRun(project, join(output, name)))
await writeFile(join(output, "independent-audit.json"), JSON.stringify(audits, null, 2) + "\n")
await mkdir(join(output, "plots"))
const result = await promisify(execFile)(runtime.python, [
  join(project, "examples/ddr-dq/plot.py"), output,
], { maxBuffer: 1024 * 1024 })
process.stdout.write(result.stdout)
console.log(`Fresh DQ/DQS simulation, all eight received histories and repeatability verified: ${output}`)
