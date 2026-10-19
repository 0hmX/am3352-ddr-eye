import { readFileSync } from 'node:fs'
import type { CircuitJson } from '../../src/schema.js'
import type { Modeling } from '../../src/geometry.js'

export function groundPlaneFixture(): { circuit: CircuitJson; modeling: Modeling } {
  const circuit = JSON.parse(readFileSync(new URL('./straight.circuit.json', import.meta.url), 'utf8')) as CircuitJson
  const modeling = JSON.parse(readFileSync(new URL('./straight.modeling.json', import.meta.url), 'utf8')) as Modeling
  modeling.reduction = 'routed-copper'
  modeling.relativePermittivity = 4.1
  modeling.channelReference = { sourcePortId: 'ground0' }
  modeling.groundReturn = { sourcePortId: 'ground1' }
  modeling.extraction.groundMeshMm = .5
  modeling.extraction.filaments = 3
  modeling.extraction.refinementFilaments = 5
  delete modeling.profiles
  modeling.stackup.push({ name: 'bottom', zMinMm: -.235, zMaxMm: -.2 })
  circuit.push({ type: 'source_net', source_net_id: 'ground', name: 'GND', is_ground: true, member_source_group_ids: [] })
  for (let i = 0; i < 2; i++) circuit.push(
    { type: 'source_port', source_port_id: `ground${i}`, source_component_id: `u${i}`, name: 'GND', pin_number: 5 },
    { type: 'pcb_port', pcb_port_id: `ground-pad${i}`, source_port_id: `ground${i}`, pcb_component_id: `pc${i}`, x: i * 10, y: -1, layers: ['bottom'] },
    { type: 'source_trace', source_trace_id: `ground-trace${i}`, connected_source_port_ids: [`ground${i}`], connected_source_net_ids: ['ground'] },
    { type: 'pcb_smtpad', pcb_smtpad_id: `ground-pad-copper${i}`, pcb_port_id: `ground-pad${i}`, pcb_component_id: `pc${i}`, x: i * 10, y: -1, layer: 'bottom', shape: 'circle', radius: .2 },
  )
  circuit.push({ type: 'pcb_copper_pour', pcb_copper_pour_id: 'ground-plane', source_net_id: 'ground', layer: 'bottom', shape: 'brep', covered_with_solder_mask: true,
    brep_shape: { outer_ring: { vertices: [{ x: -1, y: -2 }, { x: 11, y: -2 }, { x: 11, y: 2 }, { x: -1, y: 2 }] },
      inner_rings: [{ vertices: [{ x: 4, y: -.25 }, { x: 6, y: -.25 }, { x: 6, y: .25 }, { x: 4, y: .25 }] }] } })
  circuit.push({ type: 'simulation_ibis_model', simulation_ibis_model_id: 'receiver', source_component_id: 'u1',
    ibis_model_asset: { project_relative_path: 'test.ibs', url: './test.ibs', mimetype: 'text/plain' }, ibis_component_name: 'receiver',
    ibis_pin_name_to_source_port_id: { '3': 'p2', '4': 'p3' },
    ibis_pin_name_to_reference_source_port_ids: {
      '3': { pulldown_reference_source_port_id: 'ground1', ground_clamp_reference_source_port_id: 'ground1' },
      '4': { ground_clamp_reference_source_port_id: 'ground1' },
    }, model_value_corner: 'typical', include_package_parasitics: false })
  return { circuit, modeling }
}

export function routedGroundPlaneFixture() {
  const { circuit, modeling } = groundPlaneFixture()
  modeling.viaPlatingMm = .025
  modeling.viaEquivalentWidthMm = .15
  modeling.omitThroughViaStubs = true
  for (const e of circuit) {
    if (e.type === 'pcb_port' && e.source_port_id === 'ground0') e.layers = ['top']
    if (e.type === 'pcb_smtpad' && e.pcb_port_id === 'ground-pad0') e.layer = 'top'
  }
  const lead: Extract<CircuitJson[number], { type: 'pcb_trace' }> = {
    type: 'pcb_trace', pcb_trace_id: 'ground-lead', source_trace_id: 'ground-trace0', route: [
      { route_type: 'wire', x: 0, y: -1, width: .1, layer: 'top' },
      { route_type: 'wire', x: 1, y: -1, width: .1, layer: 'top' },
    ],
  }
  circuit.push(lead, { type: 'pcb_via', pcb_via_id: 'ground-via', source_net_id: 'ground',
    x: 1, y: -1, hole_diameter: .1, outer_diameter: .2, layers: ['top', 'bottom'] })
  return { circuit, modeling, lead }
}
