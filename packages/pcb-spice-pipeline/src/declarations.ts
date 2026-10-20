import {transmittedBits} from './stimulus.js'
import {fail} from './matrices.mjs'
import {selectPort} from './geometry.js'

import type {CircuitJson, SimulationExperiment, SimulationIbisModel, SimulationIbisPinState, SimulationDigitalStimulus} from './schema.js'
import type {IbisModelDefinition, IbisRunConfig, IbisReferencePorts} from '@tscircuit/ibis-to-spice'
import type {Geometry, Modeling} from './geometry.js'

export interface CircuitNodes {
  node(id: string): string
  groundSourcePortId: string
  mapping: Record<string, string>
}
export type PipelineIbisModel = SimulationIbisModel & {pipelineId: string}
export interface VoltageProbePlan {
  simulationVoltageProbeId: string
  name: string
  column: number
  signalSourceId: string
  referenceSourceId: string | null
  signalNode: string
  referenceNode: string
}
export interface EyePlan {
  simulationEyeDiagramId: string
  name: string
  simulationExperimentId: string
  simulationVoltageProbeId: string
  column: number
  unitIntervalSeconds: number
  timeOriginSeconds: number
  startTimeSeconds: number
  endTimeSeconds: number
}
export interface SimulationPlan {
  simulationExperimentId: string
  name: string
  subcircuitId: string | null
  durationSeconds: number
  startTimeSeconds: number
  maxStepSeconds: number
  experiment: SimulationExperiment
  states: SimulationIbisPinState[]
  stimuli: (SimulationDigitalStimulus & {transmission_pattern: {bits: string}})[]
  probes: VoltageProbePlan[]
  eyes: EyePlan[]
  models: PipelineIbisModel[]
}
export interface ModelRunDefinition {
  definition: IbisModelDefinition
  run: IbisRunConfig
}

const milliseconds=(value: number | undefined,label: string,{positive=false}={})=>{
  if(typeof value!=='number'||!Number.isFinite(value)||(positive?value<=0:value<0)) fail('simulation_timing',`${label}: finite ${positive?'positive':'nonnegative'} milliseconds required`)
  return value/1000
}
const exactly=<T>(items: T[],label: string): T=>{
  if(items.length!==1) fail('simulation_reference',`${label}: expected exactly one record, got ${items.length}`)
  return items[0]
}

// Resolve electrical connectivity while leaving extracted PCB channel endpoints
// distinct. Source traces describe connectivity, not ideal channels.
export function circuitNodes(circuit: CircuitJson,geometry: Geometry,modeling: Modeling): CircuitNodes {
  const parents=new Map<string,string>()
  const add=(id: string)=>{if(id&&!parents.has(id)) parents.set(id,id)}
  const find=(id: string): string=>{const parent=parents.get(id);if(parent===undefined) fail('simulation_reference',`Unknown source port/net ${id}`);if(parent===id) return id;const root=find(parent);parents.set(id,root);return root}
  const union=(ids: string[])=>{for(const id of ids) add(id);for(const id of ids.slice(1)) parents.set(find(id),find(ids[0]))}
  for(const element of circuit) {if(element.type==='source_port') add(element.source_port_id);if(element.type==='source_net') add(element.source_net_id)}
  const channelTraces=new Set(geometry.mappings.map(mapping=>mapping.sourceTraceId))
  for(const trace of circuit.filter(e=>e.type==='source_trace')) {
    if(channelTraces.has(trace.source_trace_id)) continue
    union([...(trace.connected_source_port_ids??[]),...(trace.connected_source_net_ids??[])])
  }
  const ground=selectPort(circuit,modeling.channelReference).source_port_id,groundRoot=find(ground),names=new Map([[groundRoot,'0']])
  const node=(id: string): string=>{const root=find(id),name=names.get(root)??`n${names.size}`;names.set(root,name);return name}
  for(const id of parents.keys()) node(id)
  for(const mapping of geometry.mappings) if(node(mapping.from)===node(mapping.to)) fail('channel_short',`${mapping.port}: extracted endpoints are shorted by another ideal source trace`)
  return {node,groundSourcePortId:ground,mapping:Object.fromEntries([...parents.keys()].map(id=>[id,node(id)]))}
}

export function generalDeclarations(circuit: CircuitJson,geometry: Geometry,modeling: Modeling) {
  for(const type of ['simulation_experiment','simulation_ibis_model','simulation_voltage_probe','simulation_eye_diagram','source_port','source_net','source_component']) {
    const seen=new Set<string>()
    for(const record of circuit.filter(e=>e.type===type)) {
      const id: unknown=Reflect.get(record,`${type}_id`)
      if(typeof id!=='string'||!id) fail('simulation_reference',`${type}: nonempty identifier required`)
      if(seen.has(id)) fail('simulation_reference',`Duplicate ${type} identifier ${id}`)
      seen.add(id)
    }
  }
  const errors=circuit.filter(e=>e.type==='source_invalid_component_property_error').filter(e=>['ibisModel','ibisPinStates','probeRef','simulationRef','sourcePinRef','bitDuration','transmittedData'].includes(e.property_name))
  if(errors.length) fail('native_declaration',errors.map(e=>e.message).join('; '))
  const models=circuit.filter(e=>e.type==='simulation_ibis_model').map((model,i)=>({...model,pipelineId:model.simulation_ibis_model_id??`model-${i}`}))
  if(!models.length) fail('ibis_model','At least one serialized native IBIS model required')
  const nodes=circuitNodes(circuit,geometry,modeling),ports=new Map(circuit.filter(e=>e.type==='source_port').map(e=>[e.source_port_id,e]))
  const groups=new Map(circuit.filter(e=>e.type==='source_group').map(e=>[e.source_group_id,e]))
  const components=circuit.filter(e=>e.type==='source_component')
  const componentScope=(id: string | undefined): string | null=>{
    const component=components.find(e=>e.source_component_id===id)
    if(!component) fail('simulation_scope','Missing component for scoped physical port')
    if(component.subcircuit_id) return component.subcircuit_id
    let groupId=component.source_group_id
    const visited=new Set<string>()
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
  for(const model of models) {
    const sourceComponent=exactly(components.filter(e=>e.source_component_id===model.source_component_id),`${model.pipelineId} component`)
    for(const refs of Object.values(model.ibis_pin_name_to_reference_source_port_ids??{}))
      for(const id of Object.values(refs)) if(id!==undefined&&(!ports.has(id)||ports.get(id)?.source_component_id!==sourceComponent.source_component_id)) fail('ibis_mapping',`${sourceComponent.name}: reference port points outside its chip`)
    for(const id of Object.values(model.ibis_pin_name_to_source_port_id??{})) if(!ports.has(id)||ports.get(id)?.source_component_id!==sourceComponent.source_component_id) fail('ibis_mapping',`${sourceComponent.name}: physical pin mapping points outside its chip`)
  }
  const declaredExperiments=circuit.filter(e=>e.type==='simulation_experiment')
  const declaredExperimentIds=new Set(declaredExperiments.map(experiment=>experiment.simulation_experiment_id))
  const experiments=declaredExperiments.filter(experiment=>experiment.spice_engine==='pcb_spice')
  if(!experiments.length) fail('simulation_experiment','A transient experiment with spiceEngine=pcb_spice is required')
  const pcbExperimentIds=new Set(experiments.map(experiment=>experiment.simulation_experiment_id))
  if(experiments.some(experiment=>experiment.experiment_type!=='spice_transient_analysis')||circuit.some(e=>e.type==='simulation_parameter_sweep'&&pcbExperimentIds.has(e.simulation_experiment_id))) fail('simulation_capability','This PCB backend supports unswept transient experiments only')
  const ids=new Set<string>()
  const plans: SimulationPlan[]=experiments.map(experiment=>{
    const id=experiment.simulation_experiment_id
    if(!id||ids.has(id)) fail('simulation_experiment','Experiment IDs must be unique')
    ids.add(id)
    const scopes=new Set(models.map(model=>componentScope(model.source_component_id)))
    const scope=experiment.subcircuit_id??(scopes.size===1?[...scopes][0]:undefined)
    if(scope===undefined) fail('simulation_scope',`${experiment.name}: multiple modeled subcircuits require an explicit experiment scope`)
    const scopedModels=models.filter(model=>componentScope(model.source_component_id)===scope)
    if(!scopedModels.length) fail('simulation_scope',`${experiment.name}: no models in its explicit subcircuit scope`)
    for(const mapping of geometry.mappings) for(const endpoint of [mapping.from,mapping.to]) {
      const port=ports.get(endpoint)
      if(!port) fail('ibis_mapping',`${mapping.port}: missing channel endpoint ${endpoint}`)
      if(componentScope(port.source_component_id)!==scope) fail('simulation_scope',`${experiment.name}: this explicit PCB channel belongs to another scope; separate channel configurations are required`)
    }
    const durationSeconds=milliseconds(experiment.end_time_ms,`${id} end_time_ms`,{positive:true}),startTimeSeconds=milliseconds(experiment.start_time_ms??0,`${id} start_time_ms`),maxStepSeconds=milliseconds(experiment.time_per_step,`${id} time_per_step`,{positive:true})
    if(startTimeSeconds>=durationSeconds||maxStepSeconds>=durationSeconds-startTimeSeconds) fail('simulation_timing',`${experiment.name}: recording must have positive duration and a smaller maximum timestep`)
    const states=circuit.filter(e=>e.type==='simulation_ibis_pin_state').filter(e=>e.simulation_experiment_id===id)
    const stimuli=circuit.filter(e=>e.type==='simulation_digital_stimulus').filter(e=>e.simulation_experiment_id===id).map(stimulus=>({...stimulus,transmission_pattern:{...stimulus.transmission_pattern,bits:transmittedBits(stimulus.transmission_pattern?.bits)}}))
    const stateIds=new Set<string>(),stimulusIds=new Set<string>()
    for(const state of states) {
      if(stateIds.has(state.source_port_id)) fail('ibis_state',`${experiment.name}: duplicate run state for ${state.source_port_id}`)
      stateIds.add(state.source_port_id)
      if(typeof state.is_output!=='boolean'||(state.is_output&&typeof state.is_output_enabled!=='boolean')||(!state.is_output&&state.is_output_enabled!==undefined)) fail('ibis_state',`${experiment.name}: explicit compatible input/output enable state required`)
      const attachments=scopedModels.filter(model=>Object.values(model.ibis_pin_name_to_source_port_id).includes(state.source_port_id))
      if(attachments.length!==1) fail('ibis_state',`${experiment.name}: run state must select exactly one modeled pin`)
    }
    for(const mapping of geometry.mappings) for(const endpoint of [mapping.from,mapping.to]) {
      const bindings=scopedModels.flatMap(model=>Object.values(model.ibis_pin_name_to_source_port_id)).filter(port=>port===endpoint)
      if(bindings.length!==1||!stateIds.has(endpoint)) fail('channel_model',`${experiment.name} ${mapping.port}: endpoint ${endpoint} requires exactly one modeled physical pin and an explicit run state`)
    }
    for(const stimulus of stimuli) {
      if(stimulusIds.has(stimulus.source_port_id)) fail('stimulus_duplicate',`${experiment.name}: multiple stimuli drive the same physical output`)
      stimulusIds.add(stimulus.source_port_id)
      const state=states.find(s=>s.source_port_id===stimulus.source_port_id)
      if(state?.is_output!==true||state.is_output_enabled!==true) fail('stimulus_state',`${stimulus.name}: stimulus requires an enabled IBIS output in this experiment`)
      milliseconds(stimulus.bit_duration_ms,`${stimulus.name} bit_duration_ms`,{positive:true})
      milliseconds(stimulus.start_time_ms,`${stimulus.name} start_time_ms`)
      if(![0,1].includes(stimulus.initial_state)||(stimulus.inverted!==undefined&&typeof stimulus.inverted!=='boolean')||stimulus.transmission_pattern?.transmission_type!=='bits'||typeof stimulus.transmission_pattern.repeat!=='boolean') fail('stimulus_pattern',`${stimulus.name}: explicit binary bits, inversion/repeat booleans and initial state required`)
      if(stimulus.start_time_ms/1000>=durationSeconds) fail('stimulus_coverage',`${stimulus.name}: stimulus starts after the experiment ends`)
      if(!stimulus.transmission_pattern.repeat&&(stimulus.start_time_ms+stimulus.transmission_pattern.bits.length*stimulus.bit_duration_ms)/1000<durationSeconds-1e-12*durationSeconds) fail('stimulus_coverage',`${stimulus.name}: nonrepeating bits do not cover the complete run`)
    }
    for(const state of states) if(state.is_output&&state.is_output_enabled&&!stimulusIds.has(state.source_port_id)) fail('stimulus_missing',`${experiment.name}: enabled output requires one explicit digital stimulus`)
    const eyeRecords=circuit.filter(e=>e.type==='simulation_eye_diagram').filter(e=>e.simulation_experiment_id===id)
    const probes=circuit.filter(e=>e.type==='simulation_voltage_probe').filter(e=>(e.subcircuit_id??null)===scope).map((probe,i)=>{
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
  for(const eye of circuit.filter(e=>e.type==='simulation_eye_diagram')) if(!declaredExperimentIds.has(eye.simulation_experiment_id)) fail('eye_reference',`${eye.name}: unknown or unsupported transient experiment`)
  for(const record of circuit.filter(e=>e.type==='simulation_digital_stimulus'||e.type==='simulation_ibis_pin_state')) if(!declaredExperimentIds.has(record.simulation_experiment_id)) fail('simulation_reference',`${'name' in record?record.name:record.type}: unknown transient experiment`)
  const usedModelIds=new Set(plans.flatMap(plan=>plan.models.map(model=>model.pipelineId)))
  return {models:models.filter(model=>usedModelIds.has(model.pipelineId)),nodes,plans,ports}
}

export function modelRunDefinition(model: PipelineIbisModel,plan: SimulationPlan): ModelRunDefinition {
  const pinMap=model.ibis_pin_name_to_source_port_id,selected=new Set(Object.values(pinMap))
  const pinStates: IbisRunConfig['pinStates']=Object.create(null),stimuli: IbisRunConfig['stimuli']=Object.create(null)
  for(const state of plan.states) if(selected.has(state.source_port_id)) {
    if(!state.is_output) pinStates[state.source_port_id]={mode:'input'}
    else {
      if(typeof state.is_output_enabled!=='boolean') fail('ibis_state',`${state.source_port_id}: explicit output enable state required`)
      pinStates[state.source_port_id]={mode:'output',enabled:state.is_output_enabled}
    }
  }
  for(const stimulus of plan.stimuli) if(selected.has(stimulus.source_port_id)) stimuli[stimulus.source_port_id]={unitInterval:stimulus.bit_duration_ms,startTime:stimulus.start_time_ms,initialState:stimulus.initial_state,inverted:stimulus.inverted??false,pattern:{type:'bits',bits:stimulus.transmission_pattern.bits,repeat:stimulus.transmission_pattern.repeat}}
  const references: Record<string,IbisReferencePorts>=Object.fromEntries(Object.entries(model.ibis_pin_name_to_reference_source_port_ids??{}).map(([pin,refs])=>[pin,{pullup:refs.pullup_reference_source_port_id,pulldown:refs.pulldown_reference_source_port_id,powerClamp:refs.power_clamp_reference_source_port_id,groundClamp:refs.ground_clamp_reference_source_port_id,external:refs.external_reference_source_port_id}]))
  let packagePolicy: IbisModelDefinition['packagePolicy']='omit'
  if(model.include_package_parasitics) packagePolicy='vendor'
  return {definition:{source:{file:model.ibis_model_asset.project_relative_path},component:model.ibis_component_name,pinMap,modelSelections:model.ibis_pin_name_to_model_name,references,corner:model.model_value_corner,packagePolicy},run:{duration:plan.durationSeconds*1000,pinStates,stimuli}}
}
