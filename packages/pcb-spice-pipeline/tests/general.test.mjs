import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile,writeFile,mkdir,mkdtemp,rm,stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {geometryFromCircuitJson,fastHenryDeck,fasterCapDeck,selectPort} from '../src/geometry.js'
import {generalDeclarations,circuitNodes,modelRunDefinition} from '../src/declarations.js'
import {foldProbeEye,probeWaveformRows} from '../src/metrics.mjs'
import {loopImpedance,referenceCapacitance} from '../src/matrices.mjs'
import {generalSimulationSpice,electricalSources,validateProbeScope} from '../src/general-spice.js'
import {runGeneralPipeline} from '../src/general-pipeline.js'
import {sha256} from '../src/io.mjs'
import {transmittedBits} from '../src/stimulus.js'

const read=async path=>JSON.parse(await readFile(new URL(path,import.meta.url),'utf8'))
const circuit=await read('./fixtures/straight.circuit.json'),physical=await read('./fixtures/straight.modeling.json')
const fixture=()=>{
  const cj=structuredClone(circuit),m={...structuredClone(physical),channelReference:{sourcePortId:'g0'},supplies:[{positive:{sourcePortId:'v0'},negative:{sourcePortId:'g0'},voltageV:3.3}]}
  cj.push(...['u0','u1'].map((id,i)=>({type:'source_component',source_component_id:id,name:i?'RX':'TX',source_group_id:'board-group'})),{type:'source_port',source_port_id:'g0',source_component_id:'u0',name:'GND'},{type:'source_port',source_port_id:'v0',source_component_id:'u0',name:'VDD'})
  cj.push({type:'source_group',source_group_id:'board-group',subcircuit_id:'board',is_subcircuit:true})
  for(const [index,ids] of [['p0','p1'],['p2','p3']].entries()) cj.push({type:'simulation_ibis_model',simulation_ibis_model_id:`model-${index}`,source_component_id:`u${index}`,ibis_model_asset:{project_relative_path:'models/test.ibs',url:'./models/test.ibs',mimetype:'text/plain'},ibis_component_name:'test',ibis_pin_name_to_source_port_id:Object.fromEntries(ids.map((id,i)=>[String(i+1),id])),model_value_corner:'typical',include_package_parasitics:false})
  cj.push({type:'simulation_experiment',simulation_experiment_id:'run',subcircuit_id:'board',name:'data',experiment_type:'spice_transient_analysis',spice_engine:'pcb_spice',end_time_ms:.01,start_time_ms:0,time_per_step:.000001})
  for(const [i,id] of ['p0','p1','p2','p3'].entries()) {
    const state={type:'simulation_ibis_pin_state',simulation_experiment_id:'run',source_port_id:id,is_output:i<2}
    if(state.is_output) state.is_output_enabled=true
    cj.push(state)
  }
  for(const [i,id] of ['p0','p1'].entries()) cj.push({type:'simulation_digital_stimulus',simulation_experiment_id:'run',source_port_id:id,name:`stimulus${i}`,bit_duration_ms:.001,start_time_ms:0,initial_state:0,inverted:Boolean(i),transmission_pattern:{transmission_type:'bits',bits:'001110100',repeat:true}})
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
  assert.match(deck,/^save all$/m,'retain internal branch currents referenced by vendor IBIS behavioral sources')
  assert.match(deck,/wrdata waveform.dat probe0 probe1/)
  assert.match(deck,/VDECLARED0 n\d+ 0 3\.3/)
  assert.equal(deck,generalSimulationSpice({...plan,eyes:[]},g,m,extraction,compiled,nodes,electrical),'eye display metadata never changes the electrical experiment')
})

test('canonical digital fields normalize string and array bits without changing eye timing',()=>{
  const {cj,m,g}=fixture(),before=structuredClone(cj)
  const expected=generalDeclarations(cj,g,m)
  for(const stimulus of cj.filter(e=>e.type==='simulation_digital_stimulus')) stimulus.transmission_pattern.bits=[...stimulus.transmission_pattern.bits].map(Number)
  const {plans,models}=generalDeclarations(cj,g,m),plan=plans[0]
  assert.deepEqual(plan.stimuli,expected.plans[0].stimuli)
  assert.deepEqual(modelRunDefinition(models[0],plan),modelRunDefinition(expected.models[0],expected.plans[0]))
  assert.equal(plan.stimuli[0].bit_duration_ms,.001)
  assert.equal(plan.eyes[0].unitIntervalSeconds,1e-6)
  assert.ok(Array.isArray(cj.find(e=>e.type==='simulation_digital_stimulus').transmission_pattern.bits),'source records remain unchanged')
  assert.deepEqual(expected.plans[0].stimuli.map(s=>s.transmission_pattern.bits),before.filter(e=>e.type==='simulation_digital_stimulus').map(s=>s.transmission_pattern.bits))
})

test('digital stimuli reject invalid bits and obsolete field names before solver execution',()=>{
  for(const bits of ['',[],[0,2],[false,true],['0','1'],[0,null],'012',101]) {
    const {cj,m,g}=fixture()
    cj.find(e=>e.type==='simulation_digital_stimulus').transmission_pattern.bits=bits
    assert.throws(()=>generalDeclarations(cj,g,m),/stimulus_pattern/)
  }
  for(const field of ['bit_duration_ms','transmission_pattern','transmission_type']) {
    const {cj,m,g}=fixture(),stimulus=cj.find(e=>e.type==='simulation_digital_stimulus')
    if(field==='bit_duration_ms') {stimulus.unit_interval_ms=stimulus[field];delete stimulus[field]}
    else if(field==='transmission_pattern') {stimulus.pattern=stimulus[field];delete stimulus[field]}
    else {stimulus.transmission_pattern.type='bits';delete stimulus.transmission_pattern[field]}
    assert.throws(()=>generalDeclarations(cj,g,m),/simulation_timing|stimulus_pattern/)
  }
  const {cj,m,g}=fixture(),stimulus=cj.find(e=>e.type==='simulation_digital_stimulus')
  stimulus.transmission_pattern={transmission_type:'bits',bits:[0,1],repeat:false}
  assert.throws(()=>generalDeclarations(cj,g,m),/stimulus_coverage/)
})

test('canonical DC port and net terminals preserve the explicit supply reference',()=>{
  for(const useNets of [false,true]) {
    const {cj,m,g}=fixture()
    m.supplies=[]
    cj.push({type:'source_net',source_net_id:'vdd-net'},{type:'source_net',source_net_id:'gnd-net'},...['v0','g0'].map((id,i)=>({type:'source_trace',source_trace_id:`rail-${i}`,connected_source_port_ids:[id],connected_source_net_ids:[i?'gnd-net':'vdd-net']})))
    const source={type:'simulation_voltage_source',simulation_voltage_source_id:'dc-rail',is_dc_source:true,voltage:3.3,...(useNets?{positive_source_net_id:'vdd-net',negative_source_net_id:'gnd-net'}:{positive_source_port_id:'v0',negative_source_port_id:'g0'})}
    cj.push(source)
    const nodes=circuitNodes(cj,g,m),electrical=electricalSources(cj,m,nodes)
    assert.deepEqual(electrical.lines,[`VPHYSICAL0 ${nodes.node('v0')} 0 3.3`])
    assert.ok(electrical.grounded.has(nodes.node('v0')))
    delete source.negative_source_net_id;delete source.negative_source_port_id
    assert.throws(()=>electricalSources(cj,m,nodes),/supply_reference/)
  }
})

test('missing references, duplicate controls, invalid gates and noncovering bits fail before solver execution',()=>{
  for(const mutate of [
    cj=>{cj.find(e=>e.type==='simulation_eye_diagram').simulation_voltage_probe_id='missing'},
    cj=>{cj.push({...cj.find(e=>e.type==='simulation_digital_stimulus')})},
    cj=>{cj.find(e=>e.type==='simulation_eye_diagram').end_time_ms=.02},
    cj=>{cj.find(e=>e.type==='simulation_digital_stimulus').transmission_pattern={transmission_type:'bits',bits:'001',repeat:false}},
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

test('every selected lane endpoint requires one modeled pin and explicit state before extraction',()=>{
  for(const mutate of [
    cj=>{
      for(const model of cj.filter(e=>e.type==='simulation_ibis_model')) for(const [pin,port] of Object.entries(model.ibis_pin_name_to_source_port_id)) if(['p1','p3'].includes(port)) delete model.ibis_pin_name_to_source_port_id[pin]
      return cj.filter(e=>!(['simulation_ibis_pin_state','simulation_digital_stimulus'].includes(e.type)&&['p1','p3'].includes(e.source_port_id)))
    },
    cj=>cj.filter(e=>!(e.type==='simulation_ibis_pin_state'&&e.source_port_id==='p3')),
    cj=>{cj.find(e=>e.type==='simulation_ibis_model'&&e.source_component_id==='u1').ibis_pin_name_to_source_port_id.alias='p3';return cj},
  ]) {
    const {cj,m,g}=fixture()
    assert.throws(()=>generalDeclarations(mutate(cj),g,m),/channel_model.*endpoint p[13].*exactly one modeled physical pin/)
  }
  const {cj,m,g}=fixture()
  for(const state of cj.filter(e=>e.type==='simulation_ibis_pin_state')) {
    state.is_output=['p2','p3'].includes(state.source_port_id)
    delete state.is_output_enabled
    if(state.is_output) state.is_output_enabled=true
  }
  for(const stimulus of cj.filter(e=>e.type==='simulation_digital_stimulus')) stimulus.source_port_id=stimulus.source_port_id==='p0'?'p2':'p3'
  assert.doesNotThrow(()=>generalDeclarations(cj,g,m),'physical route orientation does not constrain bidirectional run roles')
})

test('PCB engine selects its own experiment while native results and sweeps remain untouched',()=>{
  const {cj,m,g}=fixture()
  const native={type:'simulation_experiment',simulation_experiment_id:'native',name:'Native DC',spice_engine:'ngspice',experiment_type:'spice_dc_operating_point'}
  const graph={type:'simulation_transient_voltage_graph',simulation_transient_voltage_graph_id:'native-result',simulation_experiment_id:'native',timestamps_ms:[0,1],voltage_levels:[0,3.3]}
  const sweep={type:'simulation_parameter_sweep',simulation_parameter_sweep_id:'native-sweep',simulation_experiment_id:'native',parameter_type:'voltage',source_net_id:'native-net',parameter_values:[1,2],parameter_unit:'V'}
  cj.push(native,graph,sweep)
  const original=structuredClone(cj),{plans}=generalDeclarations(cj,g,m)
  assert.deepEqual(plans.map(plan=>plan.simulationExperimentId),['run'])
  assert.deepEqual(cj,original,'routing an external experiment leaves other engines and their results unchanged')
  sweep.simulation_experiment_id='run'
  assert.throws(()=>generalDeclarations(cj,g,m),/unswept transient/)
  sweep.simulation_experiment_id='native'
  cj.find(record=>record.simulation_experiment_id==='run'&&record.type==='simulation_experiment').experiment_type='spice_dc_operating_point'
  assert.throws(()=>generalDeclarations(cj,g,m),/unswept transient/)
})

test('canonical IBIS model and boolean pin states translate only at the converter boundary',()=>{
  const {cj,m,g}=fixture(),model=cj.find(record=>record.type==='simulation_ibis_model')
  model.include_package_parasitics=true
  model.model_value_corner='minimum'
  model.ibis_pin_name_to_model_name={'1':'DRIVER'}
  model.ibis_pin_name_to_reference_source_port_ids={'1':{
    pullup_reference_source_port_id:'v0',pulldown_reference_source_port_id:'g0',
    power_clamp_reference_source_port_id:'v0',ground_clamp_reference_source_port_id:'g0',external_reference_source_port_id:'v0',
  }}
  const {models,plans}=generalDeclarations(cj,g,m),{definition,run}=modelRunDefinition(models[0],plans[0])
  assert.equal(definition.component,'test')
  assert.equal(definition.corner,'minimum')
  assert.equal(definition.packagePolicy,'vendor')
  assert.deepEqual(definition.modelSelections,{'1':'DRIVER'})
  assert.deepEqual(definition.references,{'1':{pullup:'v0',pulldown:'g0',powerClamp:'v0',groundClamp:'g0',external:'v0'}})
  assert.deepEqual(run.pinStates.p0,{mode:'output',enabled:true})
  assert.equal(model.source,undefined,'the external declaration has no converter-specific source union')
})

test('pipeline verifies optional expected IBIS asset hashes before conversion, output or native tools',async t=>{
  const root=await mkdtemp(join(tmpdir(),'pipeline-asset-lock-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const {cj,m}=fixture()
  for(const component of cj.filter(record=>record.type==='source_component')) component.ftype='simple_chip'
  for(const state of cj.filter(record=>record.type==='simulation_ibis_pin_state')) {
    state.is_output=false
    delete state.is_output_enabled
  }
  for(const [pin,name] of [['rx-vdd','VDD'],['rx-gnd','GND']]) cj.push({type:'source_port',source_port_id:pin,source_component_id:'u1',name})
  cj.push({type:'source_trace',source_trace_id:'vdd',connected_source_port_ids:['v0','rx-vdd'],connected_source_net_ids:[]},
    {type:'source_trace',source_trace_id:'gnd',connected_source_port_ids:['g0','rx-gnd'],connected_source_net_ids:[]})
  const models=cj.filter(record=>record.type==='simulation_ibis_model')
  models[0].ibis_pin_name_to_source_port_id['3']='v0';models[0].ibis_pin_name_to_source_port_id['4']='g0'
  models[1].ibis_pin_name_to_source_port_id['3']='rx-vdd';models[1].ibis_pin_name_to_source_port_id['4']='rx-gnd'
  const circuitJson=cj.filter(record=>record.type!=='simulation_digital_stimulus')
  const bytes=Buffer.from('[IBIS Ver] 4.2\r\n[Component] test\r\n[Pin] signal_name model_name\r\n1 D1 IN\r\n2 D2 IN\r\n3 VDD POWER\r\n4 VSS GND\r\n[Model] IN\r\nModel_type Input\r\nC_comp 1p 1p 1p\r\n[Voltage Range] 3.3 3.3 3.3\r\n[Power Clamp]\r\n-10 -0.1 -0.1 -0.1\r\n10 0.1 0.1 0.1\r\n[Gnd Clamp]\r\n-10 -0.2 -0.2 -0.2\r\n10 0.2 0.2 0.2\r\n[End]\r\n')
  const path='models/test.ibs',file=join(root,path)
  await mkdir(join(root,'models'));await writeFile(file,bytes)
  const run=async(name,modeling,pattern)=>{
    const outputDir=join(root,name)
    await assert.rejects(runGeneralPipeline({circuitJson,modeling,baseDir:root,outputDir}),pattern)
    await assert.rejects(stat(outputDir),{code:'ENOENT'},'preflight never creates simulation output')
  }
  const locked={...m,ibisModelAssetSha256:{[path]:sha256(bytes).toUpperCase()}}
  await run('match',locked,/native_runtime/)
  await run('optional',m,/native_runtime/)
  await writeFile(file,Buffer.concat([bytes,Buffer.from('| changed valid model comment\r\n')]))
  await run('mutated',locked,/vendor_hash.*test\.ibs.*bytes differ/)
  for(const ibisModelAssetSha256 of [{},{[path]:'bad-hash'},null,[]])
    await run('missing-or-invalid', {...m,ibisModelAssetSha256}, /vendor_hash.*(?:expected|must map)/)
})

test('bits normalization enforces the schema limit before reading array entries',()=>{
  for(const bits of ['0'.repeat(65536),Array(65536).fill(1)]) assert.equal(transmittedBits(bits).length,65536)
  const oversized=Array(65537).fill(0)
  Object.defineProperty(oversized,0,{get(){throw new Error('must reject length before copying')}})
  for(const bits of ['0'.repeat(65537),oversized]) assert.throws(()=>transmittedBits(bits),/stimulus_pattern.*65536/)
  assert.throws(()=>transmittedBits(Array(2)),/stimulus_pattern/)
})

test('run dictionaries preserve special port names as own entries without prototypes',()=>{
  for(const port of ['__proto__','constructor','toString']) {
    const {cj,m,g}=fixture(),{models,plans:[plan]}=generalDeclarations(cj,g,m)
    models[0].ibis_pin_name_to_source_port_id['1']=port
    plan.states[0].source_port_id=port
    plan.stimuli[0].source_port_id=port
    const {run}=modelRunDefinition(models[0],plan)
    assert.equal(Object.getPrototypeOf(run.pinStates),null)
    assert.equal(Object.getPrototypeOf(run.stimuli),null)
    assert.ok(Object.hasOwn(run.pinStates,port))
    assert.ok(Object.hasOwn(run.stimuli,port))
    assert.equal(run.pinStates[port].mode,'output')
    assert.equal(run.stimuli[port].pattern.bits,'001110100')
  }
})

test('explicit references resolve same-chip ports outside the physical pin map',()=>{
  const {cj,m,g}=fixture(),model=cj.find(record=>record.type==='simulation_ibis_model')
  model.ibis_pin_name_to_reference_source_port_ids={'1':{pullup_reference_source_port_id:'v0',pulldown_reference_source_port_id:'g0',external_reference_source_port_id:'v0'}}
  const {models,plans:[plan]}=generalDeclarations(cj,g,m),{definition}=modelRunDefinition(models[0],plan)
  assert.deepEqual(definition.pinMap,{'1':'p0','2':'p1'})
  assert.equal(definition.references['1'].pullup,'v0')
  for(const port of ['p2','missing']) {
    model.ibis_pin_name_to_reference_source_port_ids['1'].pullup_reference_source_port_id=port
    assert.throws(()=>generalDeclarations(cj,g,m),/ibis_mapping.*reference.*outside its chip/)
  }
})
