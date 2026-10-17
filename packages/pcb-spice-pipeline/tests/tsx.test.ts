import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement as h } from 'react'
import { Circuit } from '@tscircuit/core'
import { collectSimulation, si } from 'pcb-spice-pipeline/tsx'
import type { Collector, IbisModelDefinition } from 'pcb-spice-pipeline/tsx'
import { serializeSimulation } from '../src/tsx-render.js'
import { parseRecord } from '../src/schema.js'

const model: IbisModelDefinition = { source: { content: 'not fetched during rendering' }, component: 'PART',
  pinMap: { '1': 'DATA', '2': 'GND', '3': 'VCC' }, corner: 'typical', packagePolicy: 'omit',
  references: { '1': { pullup: 'VCC', pulldown: 'GND', powerClamp: 'VCC', groundClamp: 'GND' } } }
const tree = () => h('board', { width: 10, height: 10, routingDisabled: true, schematicDisabled: true },
  h('chip', { name: 'U1', pinLabels: { pin1: 'DATA', pin2: 'GND', pin3: 'VCC' }, footprint: 'sot23' }),
  h(si.Model, { ...model, componentRef: '.U1' }),
  h(si.Transient, { name: 'SI', duration: '100ns', timePerStep: '10ps', ibisPinStates: { '.U1 > .DATA': { mode: 'output', enabled: true } } }),
  h(si.Probe, { name: 'RX', connectsTo: '.U1 > .DATA', referenceTo: '.U1 > .GND' }),
  h(si.Stimulus, { name: 'DATA', simulationRef: '.SI', drives: '.U1 > .DATA', unitInterval: '2.5ns', startTime: '0ns', initialState: 0, pattern: { type: 'bits', bits: '0011', repeat: true } }),
  h(si.Eye, { name: 'RX_EYE', simulationRef: '.SI', probeRef: '.RX', unitInterval: '2.5ns', timeOrigin: '0ns', startTime: '20ns' }))

test('ordinary published core renders TSX and local adapter serializes physical bindings without executing a simulation', async () => {
  const preview = new Circuit(); preview.add(tree()); await preview.renderUntilSettled()
  assert.equal(preview.getCircuitJson().filter(e => e.type === 'source_component').length, 1)
  assert.equal(preview.getCircuitJson().filter(e => e.type === 'simulation_experiment').length, 0)
  const circuit = new Circuit(), collector: Collector = new Map()
  circuit.add(collectSimulation(tree(), collector)); await circuit.renderUntilSettled()
  assert.equal(collector.size, 5)
  const records = serializeSimulation(circuit, collector)
  for (const record of records) parseRecord(record)
  const modelRecord = records.find(e => e.type === 'simulation_ibis_model')!
  assert.equal(modelRecord.type, 'simulation_ibis_model')
  if (modelRecord.type !== 'simulation_ibis_model') return
  const probe = records.find(e => e.type === 'simulation_voltage_probe')!
  assert.equal(probe.type, 'simulation_voltage_probe')
  if (probe.type !== 'simulation_voltage_probe') return
  assert.equal(probe.signal_input_source_port_id, modelRecord.pin_to_source_port_map['1'])
  assert.equal(probe.reference_input_source_port_id, modelRecord.pin_to_source_port_map['2'])
  const experiment = records.find(e => e.type === 'simulation_experiment')!
  assert.equal(experiment.type, 'simulation_experiment')
  if (experiment.type !== 'simulation_experiment') return
  assert.equal(experiment.execution_status, 'pending')
  assert.ok(Math.abs(experiment.end_time_ms! - .0001) < 1e-18)
})

test('two React trees keep separate collectors and missing selectors or duplicate experiment names fail', async () => {
  const make = async () => {
    const c = new Circuit(), collector: Collector = new Map()
    c.add(collectSimulation(tree(), collector)); await c.renderUntilSettled(); return { c, collector }
  }
  const [a, b] = await Promise.all([make(), make()])
  assert.equal(a.collector.size, 5); assert.equal(b.collector.size, 5)
  const modelEntry = [...a.collector.values()].find(e => e.kind === 'Model')!
  assert.equal(modelEntry.kind, 'Model')
  if (modelEntry.kind !== 'Model') return
  a.collector.set('bad', { ...modelEntry, props: { ...modelEntry.props, componentRef: '.MISSING' } })
  assert.throws(() => serializeSimulation(a.c, a.collector), /tsx_reference/)
  assert.doesNotThrow(() => serializeSimulation(b.c, b.collector))
  const experiment = [...b.collector.values()].find(e => e.kind === 'Transient')!
  b.collector.set('duplicate', experiment)
  assert.throws(() => serializeSimulation(b.c, b.collector), /tsx_name.*Duplicate/)
})

test('saved PCB simulation uses the original records without preview substitutions', () => {
  const original = [
    { type: 'source_component', source_component_id: 'u', ftype: 'simple_crystal', name: 'U1' },
    { type: 'source_port', source_port_id: 'p', source_component_id: 'u', name: 'DATA' },
  ]
  const collector: Collector = new Map([
    ['board', { kind: 'ImportedBoard', props: { circuitJson: original } }],
    ['model', { kind: 'Model', props: { ...model, pinMap: { '1': 'DATA' }, references: {}, componentRef: '.U1' } }],
  ])
  const circuit = { getCircuitJson: () => [], selectAll: () => [] }
  const records = serializeSimulation(circuit, collector)
  assert.deepEqual(records.slice(0, original.length), original)
  assert.equal(records.at(-1)?.type, 'simulation_ibis_model')
  assert.equal(original.length, 2, 'serialization does not mutate the saved PCB')
  assert.throws(() => serializeSimulation({...circuit,getCircuitJson:()=>[original[0]] as never},collector), /tsx_board.*mixed/)
})
