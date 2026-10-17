import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
const readJson=async path=>JSON.parse(await readFile(new URL(path,import.meta.url),'utf8'))
import {geometryFromCircuitJson} from '../src/geometry.js'
const small={circuitJson:await readJson('./fixtures/straight.circuit.json'),modeling:await readJson('./fixtures/straight.modeling.json')}
const real={circuitJson:await readJson('../../../am3352.circuit.json'),modeling:await readJson('./fixtures/am3352.modeling.json')}
test('actual original routed DQS lengths and 4 physical endpoints are retained',()=>{
  const g=geometryFromCircuitJson(real.circuitJson,real.modeling)
  assert.equal(g.cells.length,5)
  assert.deepEqual(g.mappings.map(m=>m.pcbPorts),[['pcb_port_13','pcb_port_361'],['pcb_port_31','pcb_port_362']])
  assert.ok(Math.abs(g.cells[2].conductors[0].lengthM-.04273605248690546)<1e-12)
  assert.ok(Math.abs(g.cells[2].conductors[1].lengthM-.04378753604968599)<1e-12)
})
test('real DQ0 and both DQS legs retain six endpoints and a shared return',()=>{
  const m=structuredClone(real.modeling)
  m.lanes.unshift({port:'DQ0',from:{component:'U1',port:'M3'},to:{component:'U3',port:'E3'}})
  const g=geometryFromCircuitJson(real.circuitJson,m)
  assert.equal(g.cells.length,5)
  assert.deepEqual(g.mappings.map(mapping=>mapping.sourceTraceId),['source_trace_14','source_trace_15','source_trace_16'])
  assert.equal(new Set(g.mappings.flatMap(mapping=>[mapping.from,mapping.to])).size,6)
  assert.ok(g.cells.every(cell=>cell.conductors.length===4))
})
test('unknown stackup, return, units and omitted pin mapping produce explicit diagnostics',()=>{
  for(const [key,value,pattern] of [['stackup',[],/stackup/],['profiles',{},/return_geometry/],['circuitJsonUnits',undefined,/units/],['lanes',[],/lanes/]]) {
    assert.throws(()=>geometryFromCircuitJson(small.circuitJson,{...small.modeling,[key]:value}),pattern)
  }
})
test('stale PCB endpoint metadata cannot silently change physical IBIS pin',()=>{
  const cj=structuredClone(small.circuitJson),trace=cj.find(e=>e.type==='pcb_trace')
  trace.route[0].start_pcb_port_id='wrong'
  assert.throws(()=>geometryFromCircuitJson(cj,small.modeling),/stale_endpoint/)
})
test('unspecified plating and ignored via stubs require explicit choices',()=>{
  assert.throws(()=>geometryFromCircuitJson(real.circuitJson,{...real.modeling,viaPlatingMm:undefined}),/viaPlatingMm/)
  assert.throws(()=>geometryFromCircuitJson(real.circuitJson,{...real.modeling,omitThroughViaStubs:false}),/via_stub/)
})
test('malformed intermediate coordinates cannot silently shorten the extracted route',()=>{
  const cj=structuredClone(small.circuitJson),trace=cj.find(e=>e.type==='pcb_trace')
  trace.route.splice(1,0,{...trace.route[0],x:5},{...trace.route[0],x:'broken'})
  assert.throws(()=>geometryFromCircuitJson(cj,small.modeling),/route\[2\].x/)
})
test('discontinuous or zero-length vias are rejected',()=>{
  const cj=structuredClone(real.circuitJson),trace=cj.find(e=>e.type==='pcb_trace'&&e.source_trace_id==='source_trace_15'),via=trace.route.find(v=>v.route_type==='via')
  via.from_layer='inner1'
  assert.throws(()=>geometryFromCircuitJson(cj,real.modeling),/via_geometry/)
})
