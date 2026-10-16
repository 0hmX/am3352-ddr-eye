import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {command} from '../src/io.mjs'

test('native command timeout rejects invalid limits and records actual termination',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'pcb-spice-timeout-'))
  const previous=process.env.PCB_SPICE_TIMEOUT_MS
  t.after(async()=>{
    if(previous===undefined) delete process.env.PCB_SPICE_TIMEOUT_MS
    else process.env.PCB_SPICE_TIMEOUT_MS=previous
    await rm(directory,{recursive:true})
  })
  process.env.PCB_SPICE_TIMEOUT_MS='0'
  await assert.rejects(command(process.execPath,[],directory,'invalid'),/native_timeout/)
  process.env.PCB_SPICE_TIMEOUT_MS='50'
  await assert.rejects(command(process.execPath,['-e','setTimeout(()=>{},5000)'],directory,'timeout'),/native_solver.*SIGTERM.*limit 50ms/)
  const receipt=JSON.parse(await readFile(join(directory,'timeout.command.json'),'utf8'))
  assert.equal(receipt.timeoutMs,50)
  assert.equal(receipt.signal,'SIGTERM')
  assert.equal(receipt.exitCode,null)
  assert.ok(receipt.elapsedMs>=50)
})
