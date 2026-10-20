import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement as h } from 'react'
import { Circuit, analog } from '@tscircuit/core'
import type { IbisModelDefinition } from '@tscircuit/props'
import { ImportedBoard } from '../src/tsx.js'
import { serializeSimulation } from '../src/tsx-render.js'
import { parseRecord } from '../src/schema.js'
import { validateCircuitRecords } from '../src/circuit-schema.mjs'

const model: IbisModelDefinition = {
  ibisModelAsset: { project_relative_path: 'models/driver.ibs', url: 'https://example.com/driver.ibs', mimetype: 'text/plain' },
  ibisComponentName: 'PART', ibisPinNameToPortLabel: { '1': 'DATA', '2': 'GND', '3': 'VCC' },
  modelValueCorner: 'typical', includePackageParasitics: false,
  ibisPinNameToReferencePortLabels: { '1': { pullup: 'VCC', pulldown: 'GND', powerClamp: 'VCC', groundClamp: 'GND' } },
}
const declarations = (componentRef = '.U1') => [
  h('ibismodel', { ...model, componentRef, key: 'model' }),
  h(analog.transientsimulation, { name: 'SI', duration: '100ns', timePerStep: '10ps', spiceEngine: 'pcb_spice',
    ibisPinStates: { '.U1 > .DATA': { isOutput: true, isOutputEnabled: true } }, key: 'transient' }),
  h('voltageprobe', { name: 'RX', connectsTo: '.U1 > .DATA', referenceTo: '.U1 > .GND', key: 'probe' }),
  h(analog.digitalstimulus, { name: 'DATA', simulationRef: '.SI', sourcePinRef: '.U1 > .DATA', bitDuration: '2.5ns', startTime: '0ns', initialState: 0,
    transmittedData: { transmissionType: 'bits', bits: '0011', repeat: true }, key: 'stimulus' }),
  h(analog.eyediagram, { name: 'RX_EYE', simulationRef: '.SI', probeRef: '.RX', unitInterval: '2.5ns', timeOrigin: '0ns', startTime: '20ns', key: 'eye' }),
]
const tree = () => h('board', { width: 10, height: 10, routingDisabled: true, schematicDisabled: true },
  h('chip', { name: 'U1', pinLabels: { pin1: 'DATA', pin2: 'GND', pin3: 'VCC' }, footprint: 'sot23' }), ...declarations())

test('native core renders ordinary TSX simulation records without fetching a model or executing a solver', async () => {
  const circuit = new Circuit()
  circuit.add(tree()); await circuit.renderUntilSettled()
  const native = circuit.getCircuitJson(), records = serializeSimulation(circuit)
  assert.deepEqual(records, native, 'ordinary TSX uses core output directly')
  for (const record of records) parseRecord(record)
  const modelRecord = records.find(e => e.type === 'simulation_ibis_model')!
  assert.equal(modelRecord.type, 'simulation_ibis_model')
  if (modelRecord.type !== 'simulation_ibis_model') return
  const probe = records.find(e => e.type === 'simulation_voltage_probe')!
  assert.equal(probe.type, 'simulation_voltage_probe')
  if (probe.type !== 'simulation_voltage_probe') return
  assert.equal(probe.signal_input_source_port_id, modelRecord.ibis_pin_name_to_source_port_id['1'])
  assert.equal(probe.reference_input_source_port_id, modelRecord.ibis_pin_name_to_source_port_id['2'])
  const experiment = records.find(e => e.type === 'simulation_experiment')!
  assert.equal(experiment.type, 'simulation_experiment')
  if (experiment.type !== 'simulation_experiment') return
  const stimulus = records.find(e => e.type === 'simulation_digital_stimulus')!
  assert.equal(stimulus.type, 'simulation_digital_stimulus')
  if (stimulus.type !== 'simulation_digital_stimulus') return
  assert.ok(Math.abs(stimulus.bit_duration_ms - .0000025) < 1e-18)
  assert.deepEqual(stimulus.transmission_pattern, { transmission_type: 'bits', bits: '0011', repeat: true })
  const eye = records.find(e => e.type === 'simulation_eye_diagram')!
  assert.equal(eye.type, 'simulation_eye_diagram')
  if (eye.type !== 'simulation_eye_diagram') return
  assert.equal(eye.unit_interval_ms, stimulus.bit_duration_ms)
  assert.equal(experiment.spice_engine, 'pcb_spice')
  assert.ok(Math.abs(experiment.end_time_ms! - .0001) < 1e-18)
})

test('saved board bridge keeps original physical records and maps native declarations to original pins', async () => {
  const source = new Circuit(); source.add(tree()); await source.renderUntilSettled()
  const original = source.getCircuitJson().filter(record => !record.type.startsWith('simulation_')).map(record => {
    if (record.type === 'source_component') return { ...record, ftype: 'simple_crystal' }
    return record
  })
  for (const record of original) {
    if ('source_component_id' in record && typeof record.source_component_id === 'string') record.source_component_id = `saved_${record.source_component_id}`
    if ('source_port_id' in record && typeof record.source_port_id === 'string') record.source_port_id = `saved_${record.source_port_id}`
  }
  const before = structuredClone(original)
  const circuit = new Circuit()
  circuit.add(h(ImportedBoard, { circuitJson: original }, ...declarations()))
  await circuit.renderUntilSettled()
  const records = serializeSimulation(circuit)
  assert.deepEqual(records.slice(0, original.length), original)
  assert.deepEqual(original, before, 'import and native serialization never mutate saved records')
  const ibis = records.find(record => record.type === 'simulation_ibis_model')!
  assert.equal(ibis.type, 'simulation_ibis_model')
  if (ibis.type !== 'simulation_ibis_model') return
  const component = original.find(record => record.type === 'source_component')!
  assert.equal(ibis.source_component_id, component.source_component_id)
  const data = original.find(record => record.type === 'source_port' && record.name === 'DATA')!
  assert.equal(data.type, 'source_port')
  if (data.type !== 'source_port') return
  assert.equal(ibis.ibis_pin_name_to_source_port_id['1'], data.source_port_id)
  assert.equal(records.filter(record => record.type === 'pcb_trace').length, original.filter(record => record.type === 'pcb_trace').length)
})


test('saved board bridge rejects a malformed native declaration alongside valid declarations', async () => {
  const source = new Circuit(); source.add(tree()); await source.renderUntilSettled()
  const original = source.getCircuitJson().filter(record => !record.type.startsWith('simulation_'))
  const circuit = new Circuit()
  circuit.add(h(ImportedBoard, { circuitJson: original }, ...declarations(),
    h('ibismodel', { ...model, componentRef: '.U1', modelValueCorner: 'average' })))
  await circuit.renderUntilSettled()
  assert.throws(() => serializeSimulation(circuit), /tsx_simulation.*Could not create ibismodel/s)
})

test('saved board bridge rejects a native declaration with an unresolved physical selector', async () => {
  const source = new Circuit(); source.add(tree()); await source.renderUntilSettled()
  const original = source.getCircuitJson().filter(record => !record.type.startsWith('simulation_'))
  const circuit = new Circuit()
  circuit.add(h(ImportedBoard, { circuitJson: original }, ...declarations(),
    h('ibismodel', { ...model, componentRef: '.MISSING' })))
  await assert.rejects(circuit.renderUntilSettled(), /IBIS component selector.*MISSING/)
})


test('saved board net probes retain their original net identity and scope', async () => {
  const source = new Circuit()
  source.add(h('board', { width: 10, height: 10, routingDisabled: true, schematicDisabled: true },
    h('chip', { name: 'U1', pinLabels: { pin1: 'DATA', pin2: 'GND', pin3: 'VCC' }, footprint: 'sot23' }),
    h('trace', { from: '.U1 > .DATA', to: 'net.DATA' })))
  await source.renderUntilSettled()
  const original = source.getCircuitJson()
  const circuit = new Circuit()
  circuit.add(h(ImportedBoard, { circuitJson: original }, ...declarations(),
    h('voltageprobe', { name: 'NET_RX', connectsTo: 'net.DATA' })))
  await circuit.renderUntilSettled()
  const records = serializeSimulation(circuit)
  const probe = records.find(record => record.type === 'simulation_voltage_probe' && record.name === 'NET_RX')!
  const net = original.find(record => record.type === 'source_net')!
  assert.equal(probe.type, 'simulation_voltage_probe'); assert.equal(net.type, 'source_net')
  if (probe.type !== 'simulation_voltage_probe' || net.type !== 'source_net') return
  assert.equal(probe.signal_input_source_net_id, net.source_net_id)
  assert.equal(probe.subcircuit_id, net.subcircuit_id)
})

test('saved boards with prior simulation declarations are rejected before native rendering', async () => {
  const source = new Circuit(); source.add(tree()); await source.renderUntilSettled()
  const circuit = new Circuit()
  assert.throws(() => circuit.add(h(ImportedBoard, { circuitJson: source.getCircuitJson() }, ...declarations())), /without existing simulation declarations or results/)
})

test('saved board pins retain their original physical identity', async () => {
  const source = new Circuit(); source.add(tree()); await source.renderUntilSettled()
  const original: unknown[] = source.getCircuitJson().filter(record => !record.type.startsWith('simulation_'))
  original.push({ type: 'source_port', source_port_id: 'saved-board-pin', source_component_id: null, name: 'EXT', pin_number: 9,
    subcircuit_id: 'subcircuit_source_group_0' })
  const circuit = new Circuit()
  circuit.add(h(ImportedBoard, { circuitJson: original }, ...declarations(), h('voltageprobe', { name: 'external-pin', connectsTo: '.EXT' })))
  await circuit.renderUntilSettled()
  const records = serializeSimulation(circuit)
  assert.doesNotThrow(() => validateCircuitRecords(records))
  const probe = records.find(record => record.type === 'simulation_voltage_probe' && record.name === 'external-pin')!
  assert.equal(probe.type, 'simulation_voltage_probe')
  if (probe.type !== 'simulation_voltage_probe') return
  assert.equal(probe.signal_input_source_port_id, 'saved-board-pin')
})


test('saved nets flattened across different physical bindings are rejected as ambiguous', async () => {
  const source = new Circuit()
  source.add(h('board', { width: 10, height: 10, routingDisabled: true, schematicDisabled: true },
    h('chip', { name: 'U1', pinLabels: { pin1: 'DATA', pin2: 'GND', pin3: 'VCC' }, footprint: 'sot23' }),
    h('trace', { from: '.U1 > .DATA', to: 'net.DATA' })))
  await source.renderUntilSettled()
  const original = source.getCircuitJson()
  const net = original.find(record => record.type === 'source_net')!
  const trace = original.find(record => record.type === 'source_trace')!
  if (net.type !== 'source_net' || trace.type !== 'source_trace') throw new Error('Fixture needs a native net trace')
  const ground = original.find(record => record.type === 'source_port' && record.name === 'GND')!
  if (ground.type !== 'source_port') throw new Error('Fixture needs a physical ground pin')
  original.push({ ...net, source_net_id: 'another-saved-net', subcircuit_id: 'another-subcircuit' })
  original.push({ ...trace, source_trace_id: 'another-saved-trace', connected_source_port_ids: [ground.source_port_id], connected_source_net_ids: ['another-saved-net'] })
  const circuit = new Circuit()
  circuit.add(h(ImportedBoard, { circuitJson: original }, ...declarations(), h('voltageprobe', { name: 'NET_RX', connectsTo: 'net.DATA' })))
  await circuit.renderUntilSettled()
  assert.throws(() => serializeSimulation(circuit), /tsx_reference.*Saved net DATA/)
})


test('explicit chip selectors remain unambiguous when a saved physical pin has the chip name as an alias', async () => {
  const source = new Circuit()
  source.add(h('board', { width: 10, height: 10, routingDisabled: true, schematicDisabled: true },
    h('chip', { name: 'U1', pinLabels: { pin1: ['DATA', 'U1'], pin2: 'GND', pin3: 'VCC' }, footprint: 'sot23' })))
  await source.renderUntilSettled()
  const original = source.getCircuitJson()
  const circuit = new Circuit()
  circuit.add(h(ImportedBoard, { circuitJson: original }, ...declarations('chip.U1')))
  await circuit.renderUntilSettled()
  const records = serializeSimulation(circuit)
  const ibis = records.find(record => record.type === 'simulation_ibis_model')!
  assert.equal(ibis.type, 'simulation_ibis_model')
  if (ibis.type !== 'simulation_ibis_model') return
  const component = original.find(record => record.type === 'source_component')!
  assert.equal(component.type, 'source_component')
  if (component.type !== 'source_component') return
  assert.equal(ibis.source_component_id, component.source_component_id)
})


test('unused connector internal aliases preserve the saved board without blocking selected native simulation', async () => {
  const source = new Circuit(); source.add(tree()); await source.renderUntilSettled()
  const original: unknown[] = source.getCircuitJson().filter(record => !record.type.startsWith('simulation_'))
  original.push({ type: 'source_component', source_component_id: 'saved-connector', ftype: 'simple_connector', name: 'J_USB0', source_group_id: 'source_group_0' })
  original.push({ type: 'source_port', source_port_id: 'saved-shield', source_component_id: 'saved-connector', name: 'SHIELD',
    port_hints: ['SHIELD', 'pin5'], subcircuit_id: 'subcircuit_source_group_0' })
  original.push({ type: 'source_port', source_port_id: 'saved-internal', source_component_id: 'saved-connector', name: 'pin5_internal_1',
    port_hints: ['pin5_internal_1', 'SHIELD', 'pin5'], subcircuit_id: 'subcircuit_source_group_0' })
  original.push({ type: 'pcb_component', pcb_component_id: 'saved-connector-pcb', source_component_id: 'saved-connector', center: { x: 2, y: 2 }, width: 1, height: 1, rotation: 0, layer: 'top' })
  for (const pin of [1, 2]) original.push({ type: 'pcb_smtpad', pcb_smtpad_id: `saved-connector-pad-${pin}`, pcb_component_id: 'saved-connector-pcb',
    port_hints: [String(pin)], shape: 'rect', x: pin + 1, y: 2, width: .5, height: .5, layer: 'top' })
  const circuit = new Circuit()
  circuit.add(h(ImportedBoard, { circuitJson: original }, ...declarations()))
  await circuit.renderUntilSettled()
  const records = serializeSimulation(circuit)
  assert.deepEqual(records.slice(0, original.length), original)
  assert.equal(records.filter(record => record.type === 'simulation_ibis_model').length, 1)
})


test('saved board bridge rejects additional physical traces inside declaration children', async () => {
  const source = new Circuit(); source.add(tree()); await source.renderUntilSettled()
  const original = source.getCircuitJson().filter(record => !record.type.startsWith('simulation_'))
  const circuit = new Circuit()
  circuit.add(h(ImportedBoard, { circuitJson: original }, ...declarations(), h('trace', { from: '.U1 > .DATA', to: '.U1 > .VCC' })))
  await circuit.renderUntilSettled()
  assert.throws(() => serializeSimulation(circuit), /tsx_board.*native simulation declarations.*Trace/)
})

test('selected saved pin names containing CSS punctuation map structurally without parsing names as selectors', async () => {
  const source = new Circuit()
  source.add(h('board', { width: 10, height: 10, routingDisabled: true, schematicDisabled: true },
    h('chip', { name: 'U1', pinLabels: { pin1: ['D+', 'DATA'], pin2: 'GND', pin3: 'VCC' }, footprint: 'sot23' })))
  await source.renderUntilSettled()
  const original = source.getCircuitJson()
  const pin = original.find(record => record.type === 'source_port' && record.pin_number === 1)!
  assert.equal(pin.type, 'source_port')
  if (pin.type !== 'source_port') return
  pin.name = 'D+'
  pin.port_hints = ['D+', 'DATA', 'pin1', '1']
  const circuit = new Circuit()
  circuit.add(h(ImportedBoard, { circuitJson: original }, ...declarations()))
  await circuit.renderUntilSettled()
  const records = serializeSimulation(circuit)
  const ibis = records.find(record => record.type === 'simulation_ibis_model')!
  assert.equal(ibis.type, 'simulation_ibis_model')
  if (ibis.type !== 'simulation_ibis_model') return
  assert.equal(ibis.ibis_pin_name_to_source_port_id['1'], pin.source_port_id)
})
