import {fail} from './matrices.mjs'
export function useNativeIbis(circuitJson,geometry,modeling,independent) {
  const errors=circuitJson.filter(e=>e.type==='source_invalid_component_property_error'&&e.property_name==='ibisModel')
  if(errors.length) fail('native_ibis',errors.map(e=>e.message).join('; '))
  const evidence={},result={}
  for(const [role,endpoint] of [['driver','from'],['receiver','to']]) {
    const ids=geometry.mappings.map(m=>m[endpoint]),ports=ids.map(id=>circuitJson.find(e=>e.type==='source_port'&&e.source_port_id===id))
    const componentIds=[...new Set(ports.map(p=>p.source_component_id))]
    if(componentIds.length!==1) fail('native_ibis',`${role}: both lanes must belong to one selected chip`)
    const componentId=componentIds[0],models=circuitJson.filter(e=>e.type==='simulation_spice_subcircuit'&&e.source_component_id===componentId)
    if(models.length!==1) fail('native_ibis',`${role}: expected one native chip.ibisModel subcircuit, got ${models.length}; install the pinned experimental core/props`)
    const native=models[0],expected=independent[role],mapping=native.spice_pin_to_source_port_map
    if(native.subcircuit_source!==expected.source) fail('native_ibis',`${role}: native emitted source differs from independent conversion of hash-locked original bytes`)
    if(Object.keys(mapping).length!==Object.keys(expected.spicePinMapping).length) fail('native_ibis',`${role}: terminal map dimension differs`)
    const resolved={}
    for(const [terminal,parentLabel] of Object.entries(expected.spicePinMapping)) {
      const lane=modeling.lanes.findIndex(l=>(l[role==='driver'?'driverPort':'receiverPort']??l.port)===parentLabel)
      let id
      if(lane>=0) id=ids[lane]
      else {
        const matches=circuitJson.filter(e=>e.type==='source_port'&&e.source_component_id===componentId&&(e.name===parentLabel||e.port_hints?.includes(parentLabel)))
        if(matches.length!==1) fail('native_ibis',`${role}: missing/ambiguous native supply port ${parentLabel}`)
        id=matches[0].source_port_id
      }
      if(mapping[terminal]!==id) fail('native_ibis',`${role}: returned ${terminal} -> ${mapping[terminal]} disagrees with selected ${id}`)
      resolved[terminal]=parentLabel
    }
    result[role]={source:native.subcircuit_source,spicePinMapping:resolved,warnings:expected.warnings}
    evidence[role]={sourceComponentId:componentId,nativeModelId:native.simulation_spice_subcircuit_id,returnedSourcePortMapping:mapping,resolvedParentPortMapping:resolved,sourceEqualsIndependentConversion:true,usedNativeSourceForSimulation:true}
  }
  return {...result,evidence}
}
