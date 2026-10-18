import type { RootCircuit, NormalComponent, Port } from '@tscircuit/core'
import { importedBoardRecords, importedBoardDeclarations } from './tsx.js'
import type { ImportedBoardInstance, SavedRecord } from './tsx.js'
import type { CircuitJson } from './schema.js'
import { fail } from './matrices.mjs'

export function serializeSimulation(circuit: RootCircuit): CircuitJson {
  const nativeRecords = circuit.getCircuitJson()
  const errors = nativeRecords.filter(record => record.type.endsWith('_error'))
  if (errors.length) fail('tsx_simulation', errors.map(record => {
    if ('message' in record) return String(record.message)
    return record.type
  }).join('\n'))
  const boards = circuit.children.flatMap(component => [component, ...component.getDescendants()]).filter(component => component.componentName === 'Board') as ImportedBoardInstance[]
  const imported = boards.filter(board => board[importedBoardRecords])
  if (!imported.length) return circuit.getCircuitJson()
  if (imported.length !== 1 || boards.length !== 1)
    fail('tsx_board', 'One imported PCB per local simulation entry is supported')
  const board = imported[0], records = board[importedBoardRecords]!
  const declarations = board[importedBoardDeclarations]
  const allowed = new Set(['Group', 'IbisModel', 'AnalogTransientSimulation', 'AnalogDigitalStimulus', 'VoltageProbe', 'AnalogEyeDiagram'])
  const physicalChild = declarations?.getDescendants().find(instance => !allowed.has(instance.componentName))
  if (physicalChild) fail('tsx_board', `ImportedBoard children must be native simulation declarations; found ${physicalChild.componentName} ${physicalChild.name}`)
  const sourceComponents = records.filter(record => record.type === 'source_component')
  const nativeComponents = board.getDescendants().filter(component => component.source_component_id && component.componentName !== 'Port')
  if (nativeComponents.length !== sourceComponents.length)
    fail('tsx_board', 'An ImportedBoard cannot be mixed with additional physical TSX elements; edit the saved board instead')
  type NativeSourceComponentId = NonNullable<NormalComponent['source_component_id']>
  type NativeSourcePortId = NonNullable<Port['source_port_id']>
  type NativeSourceNetId = string
  type NativePhysicalId = NativeSourceComponentId | NativeSourcePortId | NativeSourceNetId
  const netIds = new Map<NativeSourceNetId, string>()
  const componentIds = new Map<NativeSourceComponentId, string>(), portIds = new Map<NativeSourcePortId, string>()
  const ambiguousPortIds = new Set<NativeSourcePortId>()
  const one = <T>(values: T[], label: string): T => {
    if (values.length !== 1) fail('tsx_reference', `${label}: expected one physical match, got ${values.length}`)
    return values[0]
  }
  for (const component of sourceComponents) {
    const path = [String(component.name)]
    let groupId = component.source_group_id
    const visited = new Set<unknown>()
    while (groupId) {
      if (visited.has(groupId)) fail('tsx_reference', 'Cyclic saved board groups')
      visited.add(groupId)
      const group = records.find(record => record.type === 'source_group' && record.source_group_id === groupId)
      if (!group) fail('tsx_reference', `Missing saved group for ${component.name}`)
      path.unshift(String(group.name ?? `inflated_group_${group.source_group_id}`))
      groupId = group.parent_source_group_id
    }
    const selector = path.join(' > ')
    const chip = one(nativeComponents.filter(instance => {
      const names = [instance.name]
      let parent = instance.parent
      while (parent && parent !== board) {
        if (parent.isGroup) names.unshift(parent.name)
        parent = parent.parent
      }
      return JSON.stringify(names) === JSON.stringify(path)
    }), selector)
    if (!chip.source_component_id || componentIds.has(chip.source_component_id)) fail('tsx_reference', `Ambiguous saved component ${selector}`)
    componentIds.set(chip.source_component_id, String(component.source_component_id))
    const ports = records.filter(record => record.type === 'source_port' && record.source_component_id === component.source_component_id)
    for (const port of ports) {
      let matches = chip.getDescendants().filter((instance): instance is Port => instance.componentName === 'Port' && instance.getParentNormalComponent() === chip)
      if (port.pin_number !== undefined) matches = matches.filter(instance => instance._parsedProps.pinNumber === port.pin_number)
      else {
        const aliases = [String(port.name)]
        if (Array.isArray(port.port_hints)) aliases.push(...port.port_hints)
        matches = matches.filter(instance => instance.getNameAndAliases().some(alias => aliases.includes(alias)))
      }
      const namedMatches = matches.filter(instance => instance.name === port.name)
      if (namedMatches.length) matches = namedMatches
      // Legacy unused pads can create duplicate internal port aliases. Leave
      // those unmapped; every pin referenced by simulation must map uniquely.
      if (matches.length !== 1 || !matches[0].source_port_id) continue
      const nativePortId = matches[0].source_port_id
      if (portIds.has(nativePortId)) { portIds.delete(nativePortId); ambiguousPortIds.add(nativePortId) }
      if (!ambiguousPortIds.has(nativePortId)) portIds.set(nativePortId, String(port.source_port_id))
    }
  }
  for (const port of records.filter(record => record.type === 'source_port' && record.source_component_id === null)) {
    const nativePort = one(board.getDescendants().filter((instance): instance is Port => instance.componentName === 'Port' && instance.getParentNormalComponent() === board && instance.name === port.name), `Saved board pin ${port.name}`)
    if (!nativePort.source_port_id || portIds.has(nativePort.source_port_id) || nativePort._parsedProps.pinNumber !== port.pin_number)
      fail('tsx_reference', `Ambiguous saved board pin ${port.name}`)
    portIds.set(nativePort.source_port_id, String(port.source_port_id))
  }
  const originalPort = (id: unknown): SavedRecord => {
    const port = records.find(record => record.type === 'source_port' && record.source_port_id === id)
    if (!port) fail('tsx_reference', `Simulation references an unknown saved physical pin: ${id}`)
    return port
  }
  const portScope = (id: unknown): unknown => {
    const port = originalPort(id)
    if (port.subcircuit_id) return port.subcircuit_id
    const component = records.find(record => record.type === 'source_component' && record.source_component_id === port.source_component_id)
    if (component?.subcircuit_id) return component.subcircuit_id
    let groupId = component?.source_group_id
    const visited = new Set<unknown>()
    while (groupId) {
      if (visited.has(groupId)) fail('tsx_reference', 'Cyclic saved board groups')
      visited.add(groupId)
      const group = records.find(record => record.type === 'source_group' && record.source_group_id === groupId)
      if (!group) break
      if (group.subcircuit_id) return group.subcircuit_id
      groupId = group.parent_source_group_id
    }
    return undefined
  }
  const connectedPorts = (elements: readonly SavedRecord[], netId: unknown) => [...new Set(elements.filter(record => record.type === 'source_trace' && Array.isArray(record.connected_source_net_ids) && record.connected_source_net_ids.includes(netId)).flatMap(record => {
    if (Array.isArray(record.connected_source_port_ids)) return record.connected_source_port_ids
    return []
  }))]
  const originalNet = (id: unknown): SavedRecord => {
    const net = records.find(record => record.type === 'source_net' && record.source_net_id === id)
    if (!net) fail('tsx_reference', `Simulation references an unknown saved net: ${id}`)
    return net
  }
  const netScope = (id: unknown): unknown => {
    const net = originalNet(id)
    const scopes = new Set(connectedPorts(records, id).map(portScope))
    if (scopes.size > 1) fail('tsx_scope', `Net ${net.name} crosses saved subcircuits`)
    return net.subcircuit_id ?? [...scopes][0]
  }
  const mapNet = (id: string): string => {
    const cached = netIds.get(id)
    if (cached) return cached
    const nativeNet = one(nativeRecords.filter(record => record.type === 'source_net' && record.source_net_id === id), id)
    if (nativeNet.type !== 'source_net') fail('tsx_reference', id)
    const pins = connectedPorts(nativeRecords, id).map(port => portIds.get(String(port))).sort()
    if (pins.includes(undefined)) fail('tsx_reference', `Net ${nativeNet.name} connects outside the saved board`)
    const net = one(records.filter(record => record.type === 'source_net' && record.name === nativeNet.name && JSON.stringify(connectedPorts(records, record.source_net_id).sort()) === JSON.stringify(pins)), `Saved net ${nativeNet.name}`)
    netScope(net.source_net_id)
    netIds.set(id, String(net.source_net_id))
    return String(net.source_net_id)
  }
  const remap = (value: unknown, field = ''): unknown => {
    if (Array.isArray(value)) return value.map(item => remap(item, field))
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      let context = key
      if (field === 'ibis_pin_name_to_source_port_id') context = 'source_port_id'
      return [key, remap(item, context)]
    }))
    if (typeof value !== 'string') return value
    if (field === 'source_net_id' || field.endsWith('_source_net_id')) return mapNet(value)
    let map: Map<NativePhysicalId, string> | undefined
    if (field === 'source_component_id') map = componentIds
    if (field === 'source_port_id' || field.endsWith('_source_port_id')) map = portIds
    if (!map) return value
    const id = map.get(value)
    if (!id) fail('tsx_reference', `Native simulation cannot uniquely match ${field} ${value} to a saved physical element`)
    return id
  }
  const simulations = nativeRecords.filter(record => record.type.startsWith('simulation_')).map(record => remap(record) as SavedRecord)
  for (const record of simulations) {
    if (record.type === 'simulation_experiment') {
      const states = simulations.filter(state => state.type === 'simulation_ibis_pin_state' && state.simulation_experiment_id === record.simulation_experiment_id)
      const scopes = new Set(states.map(state => portScope(state.source_port_id)))
      if (scopes.size > 1) fail('tsx_scope', `${record.name}: selected pins cross saved subcircuits`)
      if (scopes.size) record.subcircuit_id = [...scopes][0]
    }
    if (record.type === 'simulation_voltage_probe') {
      let scope = portScope
      let signal = record.signal_input_source_port_id, reference = record.reference_input_source_port_id
      if (record.signal_input_source_net_id) { scope = netScope; signal = record.signal_input_source_net_id }
      const signalScope = scope(signal)
      let referenceScope: unknown
      if (reference) referenceScope = portScope(reference)
      if (record.reference_input_source_net_id) { reference = record.reference_input_source_net_id; referenceScope = netScope(reference) }
      if (reference && referenceScope !== signalScope)
        fail('tsx_scope', `${record.name}: probe terminals cross saved subcircuits`)
      record.subcircuit_id = signalScope
    }
  }
  return [...structuredClone(records), ...simulations] as CircuitJson
}
