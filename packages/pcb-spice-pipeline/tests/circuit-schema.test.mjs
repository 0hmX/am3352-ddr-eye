import test from 'node:test'
import assert from 'node:assert/strict'
import {access,mkdtemp,readFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {validateCircuitRecords} from '../src/circuit-schema.mjs'
import {runGeneralPipeline} from '../src/general-pipeline.js'

test('malformed physical record fails registered validation before output or solvers',async()=>{
  const root=await mkdtemp(join(tmpdir(),'circuit-schema-preflight-')),output=join(root,'fresh')
  try {
    const circuitJson=[{type:'pcb_plated_hole',pcb_plated_hole_id:'bad-hole'}]
    await assert.rejects(runGeneralPipeline({circuitJson,modeling:{},outputDir:output}),error=>error.code==='circuit_schema'&&/^circuit_schema: pcb_plated_hole bad-hole: /.test(error.message)&&error.message.length<300)
    await assert.rejects(access(output),{code:'ENOENT'})
  } finally {await rm(root,{recursive:true,force:true})}
})

test('registered valid records are checked without rewriting source values',()=>{
  const records=[{type:'source_component',source_component_id:'chip',ftype:'simple_chip',name:'CHIP'},{type:'simulation_voltage_probe',simulation_voltage_probe_id:'probe',signal_input_source_port_id:'port'}],before=structuredClone(records)
  validateCircuitRecords(records)
  assert.deepEqual(records,before)
  assert.throws(()=>validateCircuitRecords([{type:'unknown_record',unknown_record_id:'bad'}]),/unknown_record bad: no registered record schema/)
})

test('saved board schema aliases validate without rewriting geometry or accepting malformed holes',async()=>{
  const records=JSON.parse(await readFile(new URL('../../../am3352.circuit.json',import.meta.url),'utf8'))
  const original=JSON.stringify(records)
  validateCircuitRecords(records)
  assert.equal(JSON.stringify(records),original)
  const hole=structuredClone(records.find(record=>record.type==='pcb_plated_hole'&&record.shape==='circular_hole_with_rect_pad'))
  hole.hole_diameter='invalid'
  assert.throws(()=>validateCircuitRecords([hole]),/circuit_schema.*pcb_plated_hole/)
})
