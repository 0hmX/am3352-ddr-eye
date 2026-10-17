import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {runtimePaths} from '../src/runtime.mjs'

test('simulation requires separately installed solvers and has no Python prerequisite',async t=>{
  const root=await mkdtemp(join(tmpdir(),'pcb-runtime-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const old=process.env.PCB_SPICE_TOOLS,oldPython=process.env.PCB_SPICE_PYTHON
  const config=join(root,'tools.json');process.env.PCB_SPICE_TOOLS=config;process.env.PCB_SPICE_PYTHON='/python-must-never-run'
  try {
    await assert.rejects(runtimePaths({projectDir:root}),/not installed.*--setup/)
    const tools=Object.fromEntries(['fasthenry','fastercap','ngspice'].map(name=>[name,join(root,name)]))
    await writeFile(config,JSON.stringify(tools))
    await assert.rejects(runtimePaths({projectDir:root}),/fasthenry is missing/)
    for(const path of Object.values(tools)) await writeFile(path,'separately installed executable')
    const runtime=await runtimePaths({projectDir:root})
    assert.equal('python' in runtime,false)
    assert.equal(runtime.tools.ngspice,tools.ngspice)
  } finally {
    if(old===undefined)delete process.env.PCB_SPICE_TOOLS;else process.env.PCB_SPICE_TOOLS=old
    if(oldPython===undefined)delete process.env.PCB_SPICE_PYTHON;else process.env.PCB_SPICE_PYTHON=oldPython
  }
})
