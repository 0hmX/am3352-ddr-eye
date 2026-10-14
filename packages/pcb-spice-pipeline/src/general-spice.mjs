import {fail} from './matrices.mjs'
import {selectPort} from './geometry.mjs'
import {channelSpice} from './spice.mjs'

const num=value=>Number(value.toPrecision(17)).toString()
const value=(input,label,positive=false)=>{
  if(!Number.isFinite(input)||(positive&&input<=0)) fail('electrical_input',`${label}: explicit finite ${positive?'positive ':''}value required`)
  return num(input)
}
const safeComment=text=>String(text).replace(/[\r\n]/g,' ')
export function namespaceSpice(source,prefix) {
  const names=[...source.matchAll(/^\.subckt\s+(\S+)/gmi)].map(match=>match[1])
  if(!names.length) fail('ibis_contract','Converter did not emit a SPICE component wrapper')
  const renamed=new Map(names.map(name=>[name,`${prefix}_${name}`]))
  return {source:source.replace(/\S+/g,token=>renamed.get(token)??token),wrapper:renamed.get(names[0])}
}

export function electricalSources(circuit,modeling,nodes) {
  const sources=[],passives=[],activeNodes=new Set(['0']),dcConnections=[],sourceBindings=[]
  const terminals=(positive,negative)=>{activeNodes.add(positive);activeNodes.add(negative);return `${positive} ${negative}`}
  for(const [i,source] of circuit.filter(e=>e.type==='simulation_voltage_source').entries()) {
    const pos=nodes.node(source.terminal1_source_port_id),neg=nodes.node(source.terminal2_source_port_id)
    if(pos===neg) fail('supply_short','Voltage source terminals resolve to the same node')
    let expression
    if(!source.wave_shape) expression=value(source.voltage,'voltage source voltage')
    else if(source.wave_shape==='square') {
      const period=source.period===undefined?1/source.frequency:source.period/1000
      const amplitude=source.peak_to_peak_voltage??source.voltage
      const low=source.peak_to_peak_voltage===undefined?0:source.voltage-amplitude/2,high=low+amplitude
      const rise=(source.rise_time??0)/1000,fall=(source.fall_time??0)/1000
      if(rise<=0||fall<=0) fail('source_edge','Square voltage sources require explicit positive rise/fall times')
      expression=`PULSE(${value(low,'source low')} ${value(high,'source high')} ${value((source.pulse_delay??0)/1000,'source delay')} ${value(rise,'source rise',true)} ${value(fall,'source fall',true)} ${value(source.pulse_width===undefined?period*(source.duty_cycle??.5):source.pulse_width/1000,'source width',true)} ${value(period,'source period',true)})`
    } else fail('source_capability',`Voltage waveform ${source.wave_shape} is unsupported by this PCB backend`)
    sources.push(`VPHYSICAL${i} ${terminals(pos,neg)} ${expression}`)
    const port=circuit.find(e=>e.type==='source_port'&&e.source_port_id===source.terminal1_source_port_id),component=circuit.find(e=>e.type==='source_component'&&e.source_component_id===port?.source_component_id)
    sourceBindings.push({name:component?.name??source.simulation_voltage_source_id,positiveNode:pos,negativeNode:neg});dcConnections.push([pos,neg])
  }
  for(const [i,source] of (modeling.supplies??[]).entries()) {
    const pos=nodes.node(selectPort(circuit,source.positive).source_port_id),neg=nodes.node(selectPort(circuit,source.negative).source_port_id)
    if(pos===neg) fail('supply_short','Explicit supply terminals resolve to the same node')
    sources.push(`VDECLARED${i} ${terminals(pos,neg)} ${value(source.voltageV,'declared supply')}`)
    sourceBindings.push({name:`modeling.supplies[${i}]`,positiveNode:pos,negativeNode:neg});dcConnections.push([pos,neg])
  }
  for(const [i,selection] of (modeling.passiveComponents??[]).entries()) {
    const components=circuit.filter(e=>e.type==='source_component'&&(selection.sourceComponentId?e.source_component_id===selection.sourceComponentId:e.name===selection.component))
    if(components.length!==1) fail('passive_reference','Selected passive component is missing or ambiguous')
    const component=components[0],ports=circuit.filter(e=>e.type==='source_port'&&e.source_component_id===component.source_component_id).sort((a,b)=>Number(a.pin_number)-Number(b.pin_number))
    if(ports.length!==2) fail('passive_capability',`${component.name}: expected two physical ports`)
    const pos=nodes.node(ports[0].source_port_id),neg=nodes.node(ports[1].source_port_id)
    const kind=[['simple_resistor','R','resistance'],['simple_capacitor','C','capacitance'],['simple_inductor','L','inductance']].find(([type])=>component.ftype===type)
    if(!kind) fail('passive_capability',`${component.name}: only explicit resistor/capacitor/inductor models supported`)
    passives.push(`${kind[1]}PHYSICAL${i} ${terminals(pos,neg)} ${value(component[kind[2]],`${component.name} ${kind[2]}`,true)}`)
    if(kind[1]!=='C') dcConnections.push([pos,neg])
  }
  if(!sources.length) fail('supply_missing','Declare physical voltage sources or explicit source-port supplies; this backend never invents VDD')
  const grounded=new Set(['0'])
  let changed=true
  while(changed) {changed=false;for(const [a,b] of dcConnections) if(grounded.has(a)||grounded.has(b)) for(const node of [a,b]) if(!grounded.has(node)) {grounded.add(node);changed=true}}
  for(const source of sourceBindings) if(!grounded.has(source.positiveNode)||!grounded.has(source.negativeNode)) fail('floating_source',`${source.name}: ideal voltage source has no explicit DC connection to channelReference; wire its physical terminals to the modeled supply/reference ports`)
  return {lines:[...sources,...passives],activeNodes,grounded,sourceBindings,scope:{voltageSources:sources.length,passiveComponents:passives.length,unselectedBoardComponents:'Excluded from this explicitly selected channel experiment'}}
}

export function generalSimulationSpice(plan,geometry,modeling,extracted,models,nodes,electrical) {
  const lines=['Native transient: explicit physical source rails, IBIS run controls and extracted PCB channel']
  const options={reltol:1e-5,abstol:1e-12,method:'gear',...(plan.experiment.spice_options??{})}
  for(const [key,input] of Object.entries(options)) {
    if(key==='method') {if(!['gear','trap'].includes(input)) fail('spice_options','Unsupported integration method')}
    else if(!['reltol','abstol','vntol'].includes(key)||!Number.isFinite(Number(input))||Number(input)<=0) fail('spice_options',`Unsupported or invalid solver option ${key}`)
  }
  lines.push('.options '+Object.entries(options).map(([key,input])=>`${key}=${input}`).join(' '),...electrical.lines)
  for(const [i,model] of models.entries()) {
    const renamed=namespaceSpice(model.source,`IBIS${i}`)
    const wrapper=model.source.match(/^\.subckt\s+\S+\s+(.+)$/mi),terminals=wrapper[1].trim().split(/\s+/).map(terminal=>{
      const id=model.spicePinMapping[terminal]
      if(!id) fail('ibis_contract',`Missing returned terminal ${terminal}`)
      return nodes.node(id)
    })
    lines.push(`* ${safeComment(model.name)}`,renamed.source,`XIBIS${i} ${terminals.join(' ')} ${renamed.wrapper}`)
  }
  lines.push(channelSpice(extracted,modeling.sections))
  const channel=geometry.mappings.map(mapping=>nodes.node(mapping.from)).concat(geometry.mappings.map(mapping=>nodes.node(mapping.to)),'0')
  lines.push(`XCHAN ${channel.join(' ')} CHANNEL`)
  validateProbeScope(plan,geometry,models,nodes,electrical)
  lines.push('.control','set wr_singlescale','set wr_vecnames','set numdgt=17',`tran ${num(plan.maxStepSeconds)} ${num(plan.durationSeconds)} ${num(plan.startTimeSeconds)} ${num(plan.maxStepSeconds)}`)
  for(const [i,probe] of plan.probes.entries()) lines.push(`let probe${i} = ${probe.signalNode==='0'?'0':`v(${probe.signalNode})`}-${probe.referenceNode==='0'?'0':`v(${probe.referenceNode})`}`)
  lines.push(`wrdata waveform.dat ${plan.probes.map((_,i)=>`probe${i}`).join(' ')}`,'quit','.endc','.end','')
  return lines.join('\n')
}

export function validateProbeScope(plan,geometry,models,nodes,electrical) {
  const active=new Set(electrical.activeNodes)
  for(const model of models) for(const id of Object.values(model.spicePinMapping)) active.add(nodes.node(id))
  for(const model of models) for(const pin of model.metadata?.pins??[]) for(const [role,id] of Object.entries(pin.references??{})) if(!electrical.grounded.has(nodes.node(id))) fail('floating_reference',`${model.name} physical pin ${pin.physicalPin} ${role}: reference rail has no explicit source/passive DC path to channelReference`)
  for(const mapping of geometry.mappings) {active.add(nodes.node(mapping.from));active.add(nodes.node(mapping.to))}
  for(const probe of plan.probes) if(!active.has(probe.signalNode)||!active.has(probe.referenceNode)) fail('probe_observation',`${probe.name}: signal/reference is outside the declared electrical model scope`)
}
