import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {geometryFromCircuitJson,fastHenryDeck,fasterCapDeck,selectPort} from '../src/geometry.mjs'
import {generalDeclarations,circuitNodes,modelRunDefinition} from '../src/declarations.mjs'
import {foldProbeEye,probeWaveformRows} from '../src/metrics.mjs'
import {loopImpedance,referenceCapacitance} from '../src/matrices.mjs'
import {generalSimulationSpice,electricalSources,validateProbeScope} from '../src/general-spice.mjs'

const read=async path=>JSON.parse(await readFile(new URL(path,import.meta.url),'utf8'))
const circuit=await read('./fixtures/straight.circuit.json'),physical=await read('./fixtures/straight.modeling.json')
const fixture=()=>{
  const cj=structuredClone(circuit),m={...structuredClone(physical),channelReference:{sourcePortId:'g0'},supplies:[{positive:{sourcePortId:'v0'},negative:{sourcePortId:'g0'},voltageV:3.3}]}
  cj.push(...['u0','u1'].map((id,i)=>({type:'source_component',source_component_id:id,name:i?'RX':'TX',source_group_id:'board-group'})),{type:'source_port',source_port_id:'g0',source_component_id:'u0',name:'GND'},{type:'source_port',source_port_id:'v0',source_component_id:'u0',name:'VDD'})
  cj.push({type:'source_group',source_group_id:'board-group',subcircuit_id:'board',is_subcircuit:true})
  for(const [index,ids] of [['p0','p1'],['p2','p3']].entries()) cj.push({type:'simulation_ibis_model',simulation_ibis_model_id:`model-${index}`,source_component_id:`u${index}`,source:{content:'IBIS text tested separately by converter'},component:'test',pin_to_source_port_map:Object.fromEntries(ids.map((id,i)=>[String(i+1),id])),corner:'typical',package_policy:'omit'})
  cj.push({type:'simulation_experiment',simulation_experiment_id:'run',subcircuit_id:'board',name:'data',experiment_type:'spice_transient_analysis',end_time_ms:.01,start_time_ms:0,time_per_step:.000001})
  for(const [i,id] of ['p0','p1','p2','p3'].entries()) cj.push({type:'simulation_ibis_pin_state',simulation_experiment_id:'run',source_port_id:id,mode:i<2?'output':'input',...(i<2?{enabled:true}:{})})
  for(const [i,id] of ['p0','p1'].entries()) cj.push({type:'simulation_digital_stimulus',simulation_experiment_id:'run',source_port_id:id,name:`stimulus${i}`,unit_interval_ms:.001,start_time_ms:0,initial_state:0,inverted:Boolean(i),pattern:{type:'bits',bits:'001110100',repeat:true}})
  cj.push({type:'simulation_voltage_probe',simulation_voltage_probe_id:'diff',subcircuit_id:'board',name:'diff',signal_input_source_port_id:'p2',reference_input_source_port_id:'p3'},{type:'simulation_voltage_probe',simulation_voltage_probe_id:'single',subcircuit_id:'board',name:'single',signal_input_source_port_id:'p2'})
  for(const [i,probe] of ['diff','single'].entries()) cj.push({type:'simulation_eye_diagram',simulation_eye_diagram_id:`eye-${i}`,simulation_experiment_id:'run',simulation_voltage_probe_id:probe,name:probe,unit_interval_ms:.001,time_origin_ms:.00025,start_time_ms:0,end_time_ms:.01})
  return {cj,m,g:geometryFromCircuitJson(cj,m)}
}

test('one signal extraction retains its explicit return and correct 2x2 reduction',()=>{
  const m={...physical,lanes:[physical.lanes[0]]},geometry=geometryFromCircuitJson(circuit,m)
  assert.equal(geometry.cells[0].conductors.length,2)
  assert.equal((fastHenryDeck(geometry.cells[0],m.extraction).match(/\.external /g)??[]).length,2)
  assert.equal(Object.keys(fasterCapDeck(geometry.cells[0],m.extraction)).length,3)
  assert.deepEqual(loopImpedance([[2,.1],[.1,3]]),[[4.8]])
  const C=referenceCapacitance([[4,-1],[-1,3]])
  assert.ok(Math.abs(C.matrix[0][0]-2.2)<1e-15)
})

test('serialized arbitrary data and two eye measurements share one experiment deck',()=>{
  const {cj,m,g}=fixture(),{plans,nodes,models}=generalDeclarations(cj,g,m),plan=plans[0]
  assert.equal(plans.length,1);assert.equal(plan.eyes.length,2)
  assert.notEqual(nodes.node('p0'),nodes.node('p2'),'logical channel connectivity must not short routed endpoints')
  const run=modelRunDefinition(models[0],plan)
  assert.equal(run.run.stimuli.p0.pattern.bits,'001110100')
  assert.equal(run.run.stimuli.p1.inverted,true)
  assert.equal(plan.eyes[0].timeOriginSeconds,2.5e-7)
  const compiled=[{source:'.subckt BUFFER P R\nRTEST P R 1000\n.ends BUFFER\n',spicePinMapping:{P:'p0',R:'g0'},name:'test'}]
  const extraction=[{R:[[1,0],[0,1]],L:[[1,0],[0,1]],C:[[1,0],[0,1]]}],electrical=electricalSources(cj,m,nodes)
  const deck=generalSimulationSpice(plan,g,m,extraction,compiled,nodes,electrical)
  assert.equal(deck.match(/^tran /gm).length,1)
  assert.match(deck,/wrdata waveform.dat probe0 probe1/)
  assert.match(deck,/VDECLARED0 n\d+ 0 3\.3/)
  assert.equal(deck,generalSimulationSpice({...plan,eyes:[]},g,m,extraction,compiled,nodes,electrical),'eye display metadata never changes the electrical experiment')
})

test('missing references, duplicate controls, invalid gates and noncovering bits fail before solver execution',()=>{
  for(const mutate of [
    cj=>{cj.find(e=>e.type==='simulation_eye_diagram').simulation_voltage_probe_id='missing'},
    cj=>{cj.push({...cj.find(e=>e.type==='simulation_digital_stimulus')})},
    cj=>{cj.find(e=>e.type==='simulation_eye_diagram').end_time_ms=.02},
    cj=>{cj.find(e=>e.type==='simulation_digital_stimulus').pattern={type:'bits',bits:'001',repeat:false}},
    cj=>{cj.find(e=>e.type==='simulation_experiment').time_per_step=0},
    cj=>{cj.find(e=>e.type==='simulation_experiment').subcircuit_id='unrelated'},
  ]) {const {cj,m,g}=fixture();mutate(cj);assert.throws(()=>generalDeclarations(cj,g,m),/reference|duplicate|gate|cover|timing|scope/)}
})

test('duplicate bare component names and alternative ideal channel paths fail closed',()=>{
  const {cj,m,g}=fixture()
  cj.push({type:'source_component',source_component_id:'other',name:'TX'})
  assert.throws(()=>selectPort(cj,{component:'TX',port:'P1'}),/expected one source component/)
  assert.equal(selectPort(cj,{sourcePortId:'p0'}).source_port_id,'p0')
  cj.push({type:'source_trace',source_trace_id:'short',connected_source_port_ids:['p0','p2']})
  assert.throws(()=>circuitNodes(cj,g,m),/channel_short/)
})

test('orphan ideal sources and unsupplied IBIS reference rails fail preflight',()=>{
  const {cj,m,g}=fixture()
  cj.push({type:'source_component',source_component_id:'voltage',name:'ORPHAN'},{type:'source_port',source_port_id:'vspos',source_component_id:'voltage'},{type:'source_port',source_port_id:'vsneg',source_component_id:'voltage'},{type:'simulation_voltage_source',simulation_voltage_source_id:'voltage-source',terminal1_source_port_id:'vspos',terminal2_source_port_id:'vsneg',voltage:3.3,is_dc_source:false})
  const nodes=circuitNodes(cj,g,m)
  assert.throws(()=>electricalSources(cj,m,nodes),/floating_source.*ORPHAN/)
  const clean=cj.filter(e=>e.type!=='simulation_voltage_source'),declarations=generalDeclarations(clean,g,m),electrical=electricalSources(clean,m,declarations.nodes)
  const models=[{name:'test',spicePinMapping:{PAD:'p0',REF:'vspos'},metadata:{pins:[{physicalPin:'1',references:{pullup:'vspos'}}]}}]
  assert.throws(()=>validateProbeScope(declarations.plans[0],g,models,declarations.nodes,electrical),/floating_reference.*pullup/)
})

test('fixed eye origin/gates fold irregular timestamps and repeated levels without clock parity',()=>{
  const rows=[[0,0],[.2,0],[.7,1],[1.4,1],[1.8,1],[2.2,-.3],[2.8,0],[3.6,0],[4.4,1],[5,1]],eye={name:'data',column:1,unitIntervalSeconds:1,timeOriginSeconds:.25,startTimeSeconds:0,endTimeSeconds:5}
  const result=foldProbeEye(rows,eye,5)
  assert.deepEqual(result.windowOriginsSeconds,[.75,1.75,2.75])
  assert.deepEqual(result.boundaryIndices,[1,2,3])
  assert.equal(result.samples.length,15)
  assert.deepEqual(result.windowOriginsSeconds,foldProbeEye(rows.map(([time,v])=>[time,-v]),eye,5).windowOriginsSeconds)
  assert.deepEqual(foldProbeEye(rows.map(([time])=>[time,3.3]),eye,5).metrics.voltageRangeV,[3.3,3.3],'constant drive is a valid observed voltage waveform')
  const sample=result.samples[0],fraction=(sample[2]-.7)/(1.4-.7)
  assert.equal(sample[3],rows[2][1]+(rows[3][1]-rows[2][1])*fraction)
  assert.throws(()=>foldProbeEye(rows,{...eye,startTimeSeconds:4.5},5),/no complete/)
})

test('recorded probe columns remain bound and finite timestamps strictly increase',()=>{
  assert.deepEqual(probeWaveformRows('time a b\n0 1 2\n.3 1.2 2.3\n',[{},{}]),[[0,1,2],[.3,1.2,2.3]])
  assert.throws(()=>probeWaveformRows('time a\n0 1\n0 2\n',[{}]),/strictly increase/)
  assert.throws(()=>probeWaveformRows('time a\n0 NaN\n',[{}]),/finite/)
})
