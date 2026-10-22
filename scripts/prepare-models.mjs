import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { unzipSync } from "fflate"

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
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex")
await mkdir(cache, { recursive: true })
await mkdir(modelsDirectory, { recursive: true })
for (const lock of locks) {
  const archiveFile = join(cache, `${lock.archiveSha256}.zip`)
  let archive
  try { archive = await readFile(archiveFile) }
  catch (error) {
    if (error.code !== "ENOENT") throw error
    const response = await fetch(lock.url)
    if (!response.ok) throw new Error(`${lock.vendor}: HTTP ${response.status}`)
    archive = new Uint8Array(await response.arrayBuffer())
  }
  if (sha256(archive) !== lock.archiveSha256 ||
      (lock.archiveBytes !== undefined && archive.length !== lock.archiveBytes))
    throw new Error(`${lock.vendor}: archive does not match lock`)
  const bytes = unzipSync(archive, { filter: entry => entry.name === lock.archivePath })[lock.archivePath]
  if (!bytes || sha256(bytes) !== lock.sha256 ||
      (lock.fileBytes !== undefined && bytes.length !== lock.fileBytes))
    throw new Error(`${lock.vendor}: IBIS member does not match lock`)
  await writeFile(archiveFile, archive)
  await writeFile(join(modelsDirectory, lock.file), bytes)
  console.log(`Prepared models/${lock.file} (${lock.sha256})`)
}
