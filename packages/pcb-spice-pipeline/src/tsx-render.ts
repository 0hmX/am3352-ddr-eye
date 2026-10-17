import type { CircuitJson as BaseCircuitJson } from 'circuit-json'
interface RenderedInstance { source_component_id?: string | null; source_port_id?: string | null; subcircuit_id?: string | null }
interface RenderedCircuit { getCircuitJson(): BaseCircuitJson; selectAll(selector: string): RenderedInstance[] }
import { createHash } from 'node:crypto'
import { parseRecord } from './schema.js'
import type { CircuitJson } from './schema.js'
import type { Collector } from './tsx.js'
import { fail } from './matrices.mjs'

export function serializeSimulation(circuit: RenderedCircuit, collector: Collector): CircuitJson {
  const entries = [...collector.values()]
  const imported = entries.filter(entry => entry.kind === 'ImportedBoard')
  if (imported.length > 1) fail('tsx_board', 'One imported PCB per local simulation entry is supported')
  if (imported.length && circuit.getCircuitJson().some(record => ['source_component','source_trace','pcb_trace'].includes(record.type)))
    fail('tsx_board', 'An ImportedBoard cannot be mixed with additional physical TSX elements; use ordinary TSX or edit the saved board')
  const records: CircuitJson = imported.length ? structuredClone(imported[0].props.circuitJson) as CircuitJson : circuit.getCircuitJson()
  const stableId = (kind: string, value: string) => `${kind}_${createHash('sha256').update(value).digest('hex').slice(0, 16)}`
  const one = <T>(values: T[], label: string): T => {
    if (values.length !== 1) fail('tsx_reference', `${label}: expected one match, got ${values.length}; use an explicit scoped selector`)
    return values[0]
  }
  const selected = (selector: string): RenderedInstance => {
    if (!imported.length) return one(circuit.selectAll(selector), selector)
    const parts = selector.split(/\s*>\s*/).map(part => part.replace(/^\./, ''))
    if (parts.some(part => !part || /[\s#]/.test(part)) || parts.length > 2) fail('tsx_reference', `Imported PCB selectors use .COMPONENT or .COMPONENT > .PORT: ${selector}`)
    const component = one(records.filter(record => record.type === 'source_component' && record.name === parts[0]), selector)
    if (component.type !== 'source_component') fail('tsx_reference', selector)
    if (parts.length === 1) return component
    const found = one(records.filter(record => record.type === 'source_port' && record.source_component_id === component.source_component_id &&
      (record.name === parts[1] || record.port_hints?.includes(parts[1]) || `pin${record.pin_number}` === parts[1])), selector)
    if (found.type !== 'source_port') fail('tsx_reference', selector)
    return found
  }
  const port = (selector: string) => {
    const item = selected(selector)
    const id = 'source_port_id' in item ? item.source_port_id : undefined
    if (typeof id !== 'string') fail('tsx_reference', `${selector}: expected a physical source port`)
    return id
  }
  const scopeForPort = (id: string): string | undefined => {
    const p = records.find(e => e.type === 'source_port' && e.source_port_id === id)
    if (p?.type !== 'source_port') fail('tsx_reference', `${id}: missing rendered source port`)
    const component = records.find(e => e.type === 'source_component' && e.source_component_id === p.source_component_id)
    if (component?.type !== 'source_component') fail('tsx_reference', `${id}: missing rendered component`)
    if (component.subcircuit_id) return component.subcircuit_id
    let groupId = component.source_group_id
    const visited = new Set<string>()
    while (groupId) {
      if (visited.has(groupId)) fail('tsx_reference', 'Cyclic subcircuit groups')
      visited.add(groupId)
      const group = records.find(e => e.type === 'source_group' && e.source_group_id === groupId)
      if (group?.type !== 'source_group') break
      if (group.subcircuit_id) return group.subcircuit_id
      groupId = group.parent_source_group_id
    }
    return undefined
  }
  const ms = (value: number | string) => {
    if (typeof value === 'number') { if (!Number.isFinite(value)) fail('tsx_timing', 'Finite milliseconds required'); return value }
    const match = /^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*(s|ms|us|µs|ns|ps)\s*$/i.exec(value)
    if (!match) fail('tsx_timing', `Explicit time units required: ${value}`)
    const amount = Number(match[1]), unit = match[2].toLowerCase()
    return unit === 's' ? amount * 1000 : amount / ({ ms: 1, us: 1e3, 'µs': 1e3, ns: 1e6, ps: 1e9 }[unit]!)
  }
  const add = (record: unknown) => records.push(parseRecord(record))
  const named = new Map<string, string>()
  const nameId = (kind: string, name: string) => {
    if (!name?.trim() || named.has(`${kind}:${name}`)) fail('tsx_name', `Duplicate or empty ${kind} name: ${name}`)
    const id = stableId(kind, name); named.set(`${kind}:${name}`, id); return id
  }
  const lookup = (kind: string, selector: string) => {
    const id = named.get(`${kind}:${selector.replace(/^\./, '')}`)
    if (!id) fail('tsx_reference', `Unknown ${kind} reference: ${selector}`)
    return id
  }
  const modeledComponents = new Set<string>()
  for (const entry of entries) if (entry.kind === 'Model') {
    const p = entry.props, component = selected(p.componentRef)
    if (!component.source_component_id || modeledComponents.has(component.source_component_id)) fail('tsx_model', `${p.componentRef}: one model per rendered chip required`)
    modeledComponents.add(component.source_component_id)
    const localPort = (label: string) => port(`${p.componentRef} > .${label}`)
    const references = Object.fromEntries(Object.entries(p.references ?? {}).map(([pin, refs]) => [pin,
      Object.fromEntries(Object.entries(refs).map(([role, label]) => [{ powerClamp: 'power_clamp', groundClamp: 'ground_clamp' }[role] ?? role, localPort(label)]))]))
    add({ type: 'simulation_ibis_model', simulation_ibis_model_id: stableId('model', p.componentRef),
      source_component_id: component.source_component_id, source: p.source, component: p.component,
      pin_to_source_port_map: Object.fromEntries(Object.entries(p.pinMap).map(([pin, label]) => [pin, localPort(label)])),
      model_selections: p.modelSelections, references, corner: p.corner, package_policy: p.packagePolicy })
  }
  for (const entry of entries) if (entry.kind === 'Transient') {
    const p = entry.props, id = nameId('simulation_experiment', p.name)
    const states = Object.entries(p.ibisPinStates).map(([selector, state]) => ({ source_port_id: port(selector), ...state }))
    const scopes = new Set(states.map(state => scopeForPort(state.source_port_id)))
    const scope = scopes.size === 1 ? [...scopes][0] : undefined
    if (scopes.size !== 1) fail('tsx_scope', `${p.name}: all selected pins must belong to one subcircuit`)
    add({ type: 'simulation_experiment', simulation_experiment_id: id, name: p.name, subcircuit_id: scope,
      experiment_type: 'spice_transient_analysis', execution_mode: 'external', execution_status: 'pending',
      spice_engine: p.spiceEngine ?? 'ngspice', end_time_ms: ms(p.duration), start_time_ms: ms(p.startTime ?? 0),
      time_per_step: ms(p.timePerStep), spice_options: p.spiceOptions })
    for (const state of states) add({ type: 'simulation_ibis_pin_state', simulation_ibis_pin_state_id: stableId('state', id + state.source_port_id), simulation_experiment_id: id, ...state })
  }
  for (const entry of entries) if (entry.kind === 'Probe') {
    const p = entry.props, signal = port(p.connectsTo), reference = p.referenceTo ? port(p.referenceTo) : undefined
    if (reference && scopeForPort(reference) !== scopeForPort(signal)) fail('tsx_scope', `${p.name}: probe terminals cross subcircuits`)
    add({ type: 'simulation_voltage_probe', simulation_voltage_probe_id: nameId('simulation_voltage_probe', p.name),
      name: p.name, subcircuit_id: scopeForPort(signal), signal_input_source_port_id: signal, reference_input_source_port_id: reference })
  }
  for (const entry of entries) {
    if (entry.kind === 'Stimulus') {
      const p = entry.props
      add({ type: 'simulation_digital_stimulus', simulation_digital_stimulus_id: nameId('simulation_digital_stimulus', p.name),
        name: p.name, simulation_experiment_id: lookup('simulation_experiment', p.simulationRef), source_port_id: port(p.drives),
        unit_interval_ms: ms(p.unitInterval), start_time_ms: ms(p.startTime), initial_state: p.initialState, inverted: p.inverted ?? false, pattern: p.pattern })
    }
    if (entry.kind === 'Eye') {
      const p = entry.props
      add({ type: 'simulation_eye_diagram', simulation_eye_diagram_id: nameId('simulation_eye_diagram', p.name),
        name: p.name, simulation_experiment_id: lookup('simulation_experiment', p.simulationRef),
        simulation_voltage_probe_id: lookup('simulation_voltage_probe', p.probeRef), unit_interval_ms: ms(p.unitInterval),
        time_origin_ms: ms(p.timeOrigin), start_time_ms: p.startTime === undefined ? undefined : ms(p.startTime),
        end_time_ms: p.endTime === undefined ? undefined : ms(p.endTime) })
    }
  }
  return records
}
