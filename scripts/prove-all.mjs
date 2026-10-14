import { spawn } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { runtimePaths } from "../packages/pcb-spice-pipeline/src/runtime.mjs"

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const output = resolve(process.argv[2] ?? join(project, "dist", `proof-${Date.now()}`))
const cases = [
  ["ddr", "index.circuit.tsx"],
  ["differential-data", "examples/differential-data/index.circuit.tsx"],
  ["single-ended", "examples/single-ended/index.circuit.tsx"],
]
await mkdir(dirname(output), { recursive: true })
await mkdir(output, { recursive: false })
const results = []
async function execute(args, executable = process.execPath) {
  const code = await new Promise((done, reject) => {
    const child = spawn(executable, args, { cwd: project, env: process.env, stdio: "inherit" })
    child.on("error", reject)
    child.on("exit", done)
  })
  if (code !== 0) throw new Error(`Proof command failed (${code}): ${args.join(" ")}`)
}
for (const [name, entry] of cases) {
  const directory = join(output, name)
  const args = [join(project, "node_modules/pcb-spice-pipeline/src/cli.mjs"), "--repeat", entry, "--out", directory]
  await execute(args)
  const audit = join(directory, "independent-audit.json")
  await execute([join(project, "scripts/verification/audit-general.mjs"), project, join(directory, "run-a"), join(directory, "run-b"), audit])
  const repeatability = JSON.parse(await readFile(join(directory, "repeatability.json")))
  results.push({ name, entry, directory, audit, status: repeatability.status, solverResultsReused: repeatability.solverResultsReused })
}
const verify = join(project, "scripts/verification")
const projectAudit = join(output, "project-audit.json"), negatives = join(output, "negative-contract-check.json"), postprocessing = join(output, "postprocess-check.json")
await execute([join(verify, "audit-project.mjs"), project, projectAudit])
await execute([join(verify, "negative-contract-check.mjs"), project, join(output, "ddr/run-a"), negatives])
await execute([join(verify, "postprocess-check.mjs"), join(output, "ddr/run-a"), postprocessing])
await writeFile(join(output, "proof.json"), JSON.stringify({ status: "passed", cases: results, projectAudit, negatives, postprocessing }, null, 2) + "\n")
await execute([join(project, "scripts/plot-proof-overview.py"), output], (await runtimePaths({ projectDir: project })).python)
console.log(`All three fresh repeated workflows passed: ${join(output, "proof.json")}`)
