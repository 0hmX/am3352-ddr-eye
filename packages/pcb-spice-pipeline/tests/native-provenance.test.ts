import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { nativeToolEvidence } from '../src/general-pipeline.js'
import { packageRoot } from '../src/runtime.mjs'

test('native provenance rejects missing receipts, patched sources and changed binaries', async t => {
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
  await assert.rejects(nativeToolEvidence(tools), /solver_provenance/)
  await writeFile(receipt, JSON.stringify({ unmodifiedSources: false, binarySha256, lockSha256 }))
  await assert.rejects(nativeToolEvidence(tools), /solver_provenance/)
  for (const invalidLock of [undefined, 'different-lock']) {
    await writeFile(receipt, JSON.stringify({ unmodifiedSources: true, binarySha256, lockSha256: invalidLock }))
    await assert.rejects(nativeToolEvidence(tools), /solver_provenance/)
  }
  await writeFile(receipt, JSON.stringify({ unmodifiedSources: true, binarySha256, lockSha256 }))
  assert.equal((await nativeToolEvidence(tools)).ngspice.sha256, binarySha256.ngspice)
  await writeFile(tools.ngspice, 'a different executable')
  await assert.rejects(nativeToolEvidence(tools), /solver_provenance/)
  await writeFile(receipt, '{invalid json')
  await assert.rejects(nativeToolEvidence(tools), /solver_provenance/)
})
