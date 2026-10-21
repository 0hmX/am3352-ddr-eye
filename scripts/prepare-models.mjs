import { mkdir, readFile, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
const { vendorSource } = await import(new URL("./io.mjs", import.meta.resolve("pcb-spice-pipeline")))

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const ddrModels = JSON.parse(await readFile(join(projectRoot, "vendor-models.json"), "utf8"))
const exampleModels = JSON.parse(await readFile(join(projectRoot, "examples/vendor-models.lock.json"), "utf8"))
const locks = [...ddrModels, ...Object.values(exampleModels.models)]
const filenames = new Set()
for (const lock of locks) {
  if (!lock.file || basename(lock.file) !== lock.file || filenames.has(lock.file))
    throw new Error(`Vendor models require unique file names: ${lock.file}`)
  filenames.add(lock.file)
}
const cache = join(projectRoot, "node_modules/.cache/pcb-spice-pipeline/vendors")
const modelsDirectory = join(projectRoot, "models")
await mkdir(modelsDirectory, { recursive: true })
for (const lock of locks) {
  const prepared = await vendorSource(lock, cache)
  await writeFile(join(modelsDirectory, lock.file), prepared.bytes)
  console.log(`Prepared models/${lock.file} (${lock.sha256})`)
}
