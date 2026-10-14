import {fail} from './matrices.mjs'
import {selectPort} from './geometry.mjs'

const milliseconds=(value,label,{positive=false}={})=>{
  if(!Number.isFinite(value)||(positive?value<=0:value<0)) fail('simulation_timing',`${label}: finite ${positive?'positive':'nonnegative'} milliseconds required`)
  return value/1000
}
const exactly=(items,label)=>{
  if(items.length!==1) fail('simulation_reference',`${label}: expected exactly one record, got ${items.length}`)
  return items[0]
}
const referenceKeys={pullup:'pullup',pulldown:'pulldown',power_clamp:'powerClamp',ground_clamp:'groundClamp',external:'external'}

// Resolve electrical connectivity while leaving extracted PCB channels as four/two
// distinct endpoint nodes. Source traces describe connectivity, not ideal channels.
export function circuitNodes(circuit,geometry,modeling) {
  const parents=new Map()
  const add=id=>{if(id&&!parents.has(id)) parents.set(id,id)}
  const find=id=>{if(!parents.has(id)) fail('simulation_reference',`Unknown source port/net ${id}`);const p=parents.get(id);if(p!==id) parents.set(id,find(p));return parents.get(id)}
  const union=ids=>{for(const id of ids) add(id);for(const id of ids.slice(1)) parents.set(find(id),find(ids[0]))}
  for(const element of circuit) {if(element.type==='source_port') add(element.source_port_id);if(element.type==='source_net') add(element.source_net_id)}
  const channelTraces=new Set(geometry.mappings.map(mapping=>mapping.sourceTraceId))
  for(const trace of circuit.filter(e=>e.type==='source_trace')) {
    if(channelTraces.has(trace.source_trace_id)) continue
    union([...(trace.connected_source_port_ids??[]),...(trace.connected_source_net_ids??[])])
  }
  for(const net of circuit.filter(e=>e.type==='source_net')) if(net.connected_source_port_ids?.length) union([net.source_net_id,...net.connected_source_port_ids])
  const ground=selectPort(circuit,modeling.channelReference).source_port_id,groundRoot=find(ground),names=new Map([[groundRoot,'0']])
  const node=id=>{const root=find(id);if(!names.has(root)) names.set(root,`n${names.size}`);return names.get(root)}
  for(const id of parents.keys()) node(id)
  for(const mapping of geometry.mappings) if(node(mapping.from)===node(mapping.to)) fail('channel_short',`${mapping.port}: extracted endpoints are shorted by another ideal source trace`)
  return {node,groundSourcePortId:ground,mapping:Object.fromEntries([...parents.keys()].map(id=>[id,node(id)]))}
}

export function generalDeclarations(circuit,geometry,modeling) {
  for(const type of ['simulation_ibis_model','simulation_voltage_probe','simulation_eye_diagram','source_port','source_net','source_component']) {
    const seen=new Set()
    for(const record of circuit.filter(e=>e.type===type)) {
      const id=record[`${type}_id`]
      if(seen.has(id)) fail('simulation_reference',`Duplicate ${type} identifier ${id}`)
      seen.add(id)
    }
  }
  const errors=circuit.filter(e=>e.type==='source_invalid_component_property_error'&&['ibisModel','ibisPinStates','probeRef','simulationRef','drives'].includes(e.property_name))
  if(errors.length) fail('native_declaration',errors.map(e=>e.message).join('; '))
  const models=circuit.filter(e=>e.type==='simulation_ibis_model').map((model,i)=>({...model,pipelineId:model.simulation_ibis_model_id??`model-${i}`}))
  if(!models.length) fail('ibis_model','At least one serialized native IBIS model required')
  const nodes=circuitNodes(circuit,geometry,modeling),ports=new Map(circuit.filter(e=>e.type==='source_port').map(e=>[e.source_port_id,e]))
  const groups=new Map(circuit.filter(e=>e.type==='source_group').map(e=>[e.source_group_id,e]))
  const componentScope=id=>{
    const component=circuit.find(e=>e.type==='source_component'&&e.source_component_id===id)
    if(!component) fail('simulation_scope','Missing component for scoped physical port')
    if(component.subcircuit_id) return component.subcircuit_id
    let groupId=component.source_group_id
    const visited=new Set()
    while(groupId) {
      if(visited.has(groupId)) fail('simulation_scope','Cyclic source-group ownership')
      visited.add(groupId)
      const group=groups.get(groupId)
      if(!group) fail('simulation_scope','Missing source group for modeled component')
      if(group.subcircuit_id) return group.subcircuit_id
      groupId=group.parent_source_group_id
    }
    return null
  }
  for(const [i,model] of models.entries()) {
    const sourceComponent=exactly(circuit.filter(e=>e.type==='source_component'&&e.source_component_id===model.source_component_id),`${model.pipelineId} component`)
    for(const id of Object.values(model.pin_to_source_port_map??{})) if(!ports.has(id)||ports.get(id).source_component_id!==sourceComponent.source_component_id) fail('ibis_mapping',`${sourceComponent.name}: physical pin mapping points outside its chip`)
  }
  if(circuit.some(e=>e.type==='simulation_experiment'&&e.experiment_type!=='spice_transient_analysis')||circuit.some(e=>e.type==='simulation_parameter_sweep')) fail('simulation_capability','This PCB backend supports unswept transient experiments only')
  const experiments=circuit.filter(e=>e.type==='simulation_experiment'&&e.experiment_type==='spice_transient_analysis')
  if(!experiments.length) fail('simulation_experiment','Native transient experiment required')
  const ids=new Set()
  const plans=experiments.map(experiment=>{
    const id=experiment.simulation_experiment_id
    if(!id||ids.has(id)) fail('simulation_experiment','Experiment IDs must be unique')
    ids.add(id)
    if(experiment.spice_engine&&experiment.spice_engine!=='ngspice') fail('simulation_capability',`${experiment.name}: this native PCB backend requires ngspice`)
    const scopes=new Set(models.map(model=>componentScope(model.source_component_id)))
    const scope=experiment.subcircuit_id??(scopes.size===1?[...scopes][0]:undefined)
    if(scope===undefined) fail('simulation_scope',`${experiment.name}: multiple modeled subcircuits require an explicit experiment scope`)
    const scopedModels=models.filter(model=>componentScope(model.source_component_id)===scope)
    if(!scopedModels.length) fail('simulation_scope',`${experiment.name}: no models in its explicit subcircuit scope`)
    for(const mapping of geometry.mappings) for(const endpoint of [mapping.from,mapping.to]) {
      const port=ports.get(endpoint)
      if(componentScope(port.source_component_id)!==scope) fail('simulation_scope',`${experiment.name}: this explicit PCB channel belongs to another scope; separate channel configurations are required`)
    }
    const durationSeconds=milliseconds(experiment.end_time_ms,`${id} end_time_ms`,{positive:true}),startTimeSeconds=milliseconds(experiment.start_time_ms??0,`${id} start_time_ms`),maxStepSeconds=milliseconds(experiment.time_per_step,`${id} time_per_step`,{positive:true})
    if(startTimeSeconds>=durationSeconds||maxStepSeconds>=durationSeconds-startTimeSeconds) fail('simulation_timing',`${experiment.name}: recording must have positive duration and a smaller maximum timestep`)
    if(experiment.simulation_parameter_sweep) fail('simulation_capability','Parameter sweeps are not supported by this PCB backend')
    const states=circuit.filter(e=>e.type==='simulation_ibis_pin_state'&&e.simulation_experiment_id===id)
    const stimuli=circuit.filter(e=>e.type==='simulation_digital_stimulus'&&e.simulation_experiment_id===id)
    const stateIds=new Set(),stimulusIds=new Set()
    for(const state of states) {
      if(stateIds.has(state.source_port_id)) fail('ibis_state',`${experiment.name}: duplicate run state for ${state.source_port_id}`)
      stateIds.add(state.source_port_id)
      if(!['input','output'].includes(state.mode)||(state.mode==='output'&&typeof state.enabled!=='boolean')) fail('ibis_state',`${experiment.name}: explicit compatible input/output enable state required`)
      const attachments=scopedModels.filter(model=>Object.values(model.pin_to_source_port_map).includes(state.source_port_id))
      if(attachments.length!==1) fail('ibis_state',`${experiment.name}: run state must select exactly one modeled pin`)
    }
    for(const stimulus of stimuli) {
      if(stimulusIds.has(stimulus.source_port_id)) fail('stimulus_duplicate',`${experiment.name}: multiple stimuli drive the same physical output`)
      stimulusIds.add(stimulus.source_port_id)
      const state=states.find(s=>s.source_port_id===stimulus.source_port_id)
      if(state?.mode!=='output'||state.enabled!==true) fail('stimulus_state',`${stimulus.name}: stimulus requires an enabled IBIS output in this experiment`)
      milliseconds(stimulus.unit_interval_ms,`${stimulus.name} unit_interval_ms`,{positive:true})
      milliseconds(stimulus.start_time_ms,`${stimulus.name} start_time_ms`)
      if(![0,1].includes(stimulus.initial_state)||(stimulus.inverted!==undefined&&typeof stimulus.inverted!=='boolean')||stimulus.pattern?.type!=='bits'||!/^[01]+$/.test(stimulus.pattern.bits)||typeof stimulus.pattern.repeat!=='boolean') fail('stimulus_pattern',`${stimulus.name}: explicit binary bits, inversion/repeat booleans and initial state required`)
      if(stimulus.start_time_ms>=experiment.end_time_ms) fail('stimulus_coverage',`${stimulus.name}: stimulus starts after the experiment ends`)
      if(!stimulus.pattern.repeat&&stimulus.start_time_ms+stimulus.pattern.bits.length*stimulus.unit_interval_ms<experiment.end_time_ms-1e-12*experiment.end_time_ms) fail('stimulus_coverage',`${stimulus.name}: nonrepeating bits do not cover the complete run`)
    }
    for(const state of states) if(state.mode==='output'&&state.enabled&&!stimulusIds.has(state.source_port_id)) fail('stimulus_missing',`${experiment.name}: enabled output requires one explicit digital stimulus`)
    const eyeRecords=circuit.filter(e=>e.type==='simulation_eye_diagram'&&e.simulation_experiment_id===id)
    const probes=circuit.filter(e=>e.type==='simulation_voltage_probe'&&(e.subcircuit_id??null)===scope).map((probe,i)=>{
      const signal=probe.signal_input_source_port_id??probe.signal_input_source_net_id
      const reference=probe.reference_input_source_port_id??probe.reference_input_source_net_id
      if(!signal) fail('probe_reference',`${probe.name}: signal port/net required`)
      for(const source of [signal,reference].filter(Boolean)) if(!circuit.some(e=>(e.type==='source_port'&&e.source_port_id===source)||(e.type==='source_net'&&e.source_net_id===source))) fail('probe_reference',`${probe.name}: unknown signal/reference source`)
      const signalNode=nodes.node(signal),referenceNode=reference?nodes.node(reference):'0'
      if(signalNode===referenceNode) fail('probe_reference',`${probe.name}: signal and reference resolve to the same circuit node`)
      return {simulationVoltageProbeId:probe.simulation_voltage_probe_id,name:probe.name??probe.simulation_voltage_probe_id,column:i+1,signalSourceId:signal,referenceSourceId:reference??null,signalNode,referenceNode}
    })
    if(!probes.length) fail('simulation_probe',`${experiment.name}: at least one voltage probe required`)
    const eyes=eyeRecords.map(eye=>{
      const probe=exactly(probes.filter(p=>p.simulationVoltageProbeId===eye.simulation_voltage_probe_id),`${eye.name} probeRef`)
      const unitIntervalSeconds=milliseconds(eye.unit_interval_ms,`${eye.name} UI`,{positive:true}),timeOriginSeconds=eye.time_origin_ms/1000
      if(!Number.isFinite(timeOriginSeconds)) fail('eye_timing',`${eye.name}: explicit finite timeOrigin required`)
      const start=eye.start_time_ms===undefined?startTimeSeconds:milliseconds(eye.start_time_ms,`${eye.name} startTime`),end=eye.end_time_ms===undefined?durationSeconds:milliseconds(eye.end_time_ms,`${eye.name} endTime`)
      if(start<startTimeSeconds||end>durationSeconds||start>=end||end-start<2*unitIntervalSeconds) fail('eye_timing',`${eye.name}: measurement gate must fit the recorded run and contain a complete two-UI window`)
      return {simulationEyeDiagramId:eye.simulation_eye_diagram_id,name:eye.name,simulationExperimentId:id,simulationVoltageProbeId:probe.simulationVoltageProbeId,column:probe.column,unitIntervalSeconds,timeOriginSeconds,startTimeSeconds:start,endTimeSeconds:end}
    })
    return {simulationExperimentId:id,name:experiment.name,subcircuitId:scope,durationSeconds,startTimeSeconds,maxStepSeconds,experiment,states,stimuli,probes,eyes,models:scopedModels}
  })
  for(const eye of circuit.filter(e=>e.type==='simulation_eye_diagram')) if(!ids.has(eye.simulation_experiment_id)) fail('eye_reference',`${eye.name}: unknown or unsupported transient experiment`)
  for(const record of circuit.filter(e=>['simulation_digital_stimulus','simulation_ibis_pin_state'].includes(e.type))) if(!ids.has(record.simulation_experiment_id)) fail('simulation_reference',`${record.name??record.type}: unknown transient experiment`)
  return {models,nodes,plans,ports}
}

export function modelRunDefinition(model,plan) {
  const localPort=id=>id
  const pinMap=Object.fromEntries(Object.entries(model.pin_to_source_port_map).map(([pin,id])=>[pin,localPort(id)]))
  const selected=new Set(Object.values(pinMap)),pinStates={},stimuli={}
  for(const state of plan.states) if(selected.has(state.source_port_id)) pinStates[localPort(state.source_port_id)]={mode:state.mode,...(state.mode==='output'?{enabled:state.enabled}:{})}
  for(const stimulus of plan.stimuli) if(selected.has(stimulus.source_port_id)) stimuli[localPort(stimulus.source_port_id)]={unitInterval:stimulus.unit_interval_ms,startTime:stimulus.start_time_ms,initialState:stimulus.initial_state,inverted:stimulus.inverted??false,pattern:stimulus.pattern}
  const references=Object.fromEntries(Object.entries(model.references??{}).map(([pin,refs])=>[pin,Object.fromEntries(Object.entries(refs).map(([key,id])=>[referenceKeys[key]??key,localPort(id)]))]))
  return {definition:{source:model.source,component:model.component,pinMap,modelSelections:model.model_selections,references,corner:model.corner,packagePolicy:model.package_policy},run:{duration:plan.durationSeconds*1000,pinStates,stimuli}}
}
