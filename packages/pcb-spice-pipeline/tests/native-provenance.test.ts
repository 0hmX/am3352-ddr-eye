import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { nativeToolEvidence } from '../src/general-pipeline.js'
import { packageRoot } from '../src/runtime.mjs'

test('native provenance binds binaries, solver lock and dynamically loaded runtime files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pcb-native-provenance-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const tools = { configPath: join(directory, 'tools.json'), fasthenry: join(directory, 'fasthenry'),
    fastercap: join(directory, 'fastercap'), ngspice: join(directory, 'ngspice') }
  const binarySha256: Record<string, string> = {}
  for (const name of ['fasthenry', 'fastercap', 'ngspice'] as const) {
    await writeFile(tools[name], name)
    binarySha256[name] = createHash('sha256').update(name).digest('hex')
  }
  const receipt = join(directory, 'build-receipt.json')
  const lockSha256 = createHash('sha256').update(await readFile(join(packageRoot, 'toolchain-lock.json'))).digest('hex')
  const digest = (value: string) => createHash('sha256').update(value).digest('hex')
  const library = join(directory, 'wxwidgets-prefix', 'lib', 'libwx.1.dylib')
  const libraryLink = join(directory, 'wxwidgets-prefix', 'lib', 'libwx.dylib')
  const spinit = join(directory, 'ngspice-prefix', 'share', 'ngspice', 'scripts', 'spinit')
  await mkdir(join(directory, 'wxwidgets-prefix', 'lib'), { recursive: true })
  await mkdir(join(directory, 'ngspice-prefix', 'share', 'ngspice', 'scripts'), { recursive: true })
  await writeFile(library, 'library bytes')
  await writeFile(spinit, 'set ngbehavior=all')
  await symlink('libwx.1.dylib', libraryLink)
  const runtimeArtifacts = {
    'wxwidgets-prefix': { 'lib/libwx.1.dylib': { sha256: digest('library bytes') }, 'lib/libwx.dylib': { symlink: 'libwx.1.dylib' } },
    'ngspice-prefix': { 'share/ngspice/scripts/spinit': { sha256: digest('set ngbehavior=all') } },
  }
  await assert.rejects(nativeToolEvidence(tools), /solver_provenance/)
  await writeFile(receipt, JSON.stringify({ unmodifiedSources: false, binarySha256, lockSha256, runtimeArtifacts }))
  await assert.rejects(nativeToolEvidence(tools), /solver_provenance/)
  for (const invalidLock of [undefined, 'different-lock']) {
    await writeFile(receipt, JSON.stringify({ unmodifiedSources: true, binarySha256, lockSha256: invalidLock, runtimeArtifacts }))
    await assert.rejects(nativeToolEvidence(tools), /solver_provenance/)
  }
  const valid = { unmodifiedSources: true, binarySha256, lockSha256, runtimeArtifacts, runtimeRoot: directory }
  await writeFile(receipt, JSON.stringify({ ...valid, runtimeArtifacts: undefined }))
  await assert.rejects(nativeToolEvidence(tools), /solver_provenance/)
  await writeFile(receipt, JSON.stringify(valid))
  assert.equal((await nativeToolEvidence(tools)).ngspice.sha256, binarySha256.ngspice)
  for (const name of ['SPICE_LIB_DIR', 'SPICE_SCRIPTS', 'DYLD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'LD_LIBRARY_PATH', 'LD_PRELOAD']) {
    const previous = process.env[name]
    try {
      process.env[name] = '/unrecorded-runtime-override'
      await assert.rejects(nativeToolEvidence(tools), /solver_provenance/)
    } finally {
      if (previous === undefined) delete process.env[name]
      else process.env[name] = previous
    }
  }
  for (const [file, original] of [[library, 'library bytes'], [spinit, 'set ngbehavior=all']]) {
    await writeFile(file, 'changed runtime bytes')
    await assert.rejects(nativeToolEvidence(tools), /solver_provenance/)
    await writeFile(file, original)
  }
  const extra = join(directory, 'ngspice-prefix', 'unexpected-init')
  await writeFile(extra, 'extra runtime file')
  await assert.rejects(nativeToolEvidence(tools), /solver_provenance/)
  await rm(extra)
  await rm(library)
  await assert.rejects(nativeToolEvidence(tools), /solver_provenance/)
  await writeFile(library, 'library bytes')
  await rm(libraryLink)
  await symlink('different-target', libraryLink)
  await assert.rejects(nativeToolEvidence(tools), /solver_provenance/)
  await rm(libraryLink)
  await symlink('libwx.1.dylib', libraryLink)
  const prefix = join(directory, 'wxwidgets-prefix'), movedPrefix = join(directory, 'wxwidgets-real')
  await rename(prefix, movedPrefix)
  await symlink(movedPrefix, prefix)
  await assert.rejects(nativeToolEvidence(tools), /solver_provenance/)
  await rm(prefix)
  await rename(movedPrefix, prefix)
  await writeFile(tools.ngspice, 'a different executable')
  await assert.rejects(nativeToolEvidence(tools), /solver_provenance/)
  await writeFile(receipt, '{invalid json')
  await assert.rejects(nativeToolEvidence(tools), /solver_provenance/)
})
