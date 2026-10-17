import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import type { CircuitJson } from 'circuit-json'
import { channelSpice, type ChannelMatrices, type Matrix } from '../src/spice.js'
import { fastHenryDeck, fasterCapDeck, geometryFromCircuitJson, type Modeling } from '../src/geometry.js'

const baseCircuit: CircuitJson = JSON.parse(await readFile(new URL('./fixtures/straight.circuit.json', import.meta.url), 'utf8'))
const baseModeling: Modeling = JSON.parse(await readFile(new URL('./fixtures/straight.modeling.json', import.meta.url), 'utf8'))
function threeSignals(): { circuit: CircuitJson; modeling: Modeling } {
  const circuit = structuredClone(baseCircuit), modeling = structuredClone(baseModeling)
  for (const [oldId, newId, oldPcb, newPcb] of [['p0', 'p4', 'b0', 'b4'], ['p2', 'p5', 'b2', 'b5']]) {
    const source = circuit.find(element => element.type === 'source_port' && element.source_port_id === oldId)
    const pcb = circuit.find(element => element.type === 'pcb_port' && element.pcb_port_id === oldPcb)
    assert.ok(source?.type === 'source_port' && pcb?.type === 'pcb_port')
    circuit.push({ ...source, source_port_id: newId }, { ...pcb, pcb_port_id: newPcb, source_port_id: newId, y: 1.125 })
  }
  const sourceTrace = circuit.find(element => element.type === 'source_trace' && element.source_trace_id === 's0')
  const pcbTrace = circuit.find(element => element.type === 'pcb_trace' && element.pcb_trace_id === 't0')
  assert.ok(sourceTrace?.type === 'source_trace' && pcbTrace?.type === 'pcb_trace')
  circuit.push({ ...sourceTrace, source_trace_id: 's2', connected_source_port_ids: ['p4', 'p5'] }, {
    ...pcbTrace, pcb_trace_id: 't2', source_trace_id: 's2', route: pcbTrace.route.map((point, index) => {
      assert.equal(point.route_type, 'wire')
      return { ...point, y: 1.125, ...(index === 0 ? { start_pcb_port_id: 'b4' } : { end_pcb_port_id: 'b5' }) }
    }),
  })
  modeling.lanes.push({ port: 'DQ_NEIGHBOR', sourceTraceId: 's2', from: { sourcePortId: 'p4' }, to: { sourcePortId: 'p5' } })
  return { circuit, modeling }
}

test('all three selected signals and the common return reach both solver inputs in declared order', () => {
  const { circuit, modeling } = threeSignals()
  const geometry = geometryFromCircuitJson(circuit, modeling)
  assert.deepEqual(geometry.mappings.map(({ from, to }) => [from, to]), [['p0', 'p2'], ['p1', 'p3'], ['p4', 'p5']])
  const cell = geometry.cells[0]
  assert.deepEqual(cell.conductors.map(conductor => conductor.name), ['sig0', 'sig1', 'sig2', 'return'])
  const inductance = fastHenryDeck(cell, modeling.extraction)
  assert.deepEqual([...inductance.matchAll(/^\.external (\S+) (\S+)$/gm)].map(match => match.slice(1)),
    [['N0a', 'N0b'], ['N1a', 'N1b'], ['N2a', 'N2b'], ['N3a', 'N3b']])
  const capacitance = fasterCapDeck(cell, modeling.extraction)
  assert.deepEqual(capacitance['channel.lst'].split('\n').filter(line => line.startsWith('C ')).map(line => line.split(' ')[1]),
    ['sig0.txt', 'sig1.txt', 'sig2.txt', 'return.txt'])
})

test('unsupported fan-out, duplicated physical lanes and missing neighbor routes fail explicitly', () => {
  const branched = threeSignals()
  const source = branched.circuit.find(element => element.type === 'source_trace' && element.source_trace_id === 's0')
  assert.ok(source?.type === 'source_trace')
  source.connected_source_port_ids.push('p4')
  assert.throws(() => geometryFromCircuitJson(branched.circuit, branched.modeling), /route_selection.*fan-out/)

  const duplicate = threeSignals()
  duplicate.modeling.lanes[2] = { ...duplicate.modeling.lanes[0], port: 'DUPLICATE' }
  assert.throws(() => geometryFromCircuitJson(duplicate.circuit, duplicate.modeling), /pin_mapping.*distinct physical/)

  const missing = threeSignals()
  missing.circuit = missing.circuit.filter(element => !(element.type === 'pcb_trace' && element.pcb_trace_id === 't2'))
  assert.throws(() => geometryFromCircuitJson(missing.circuit, missing.modeling), /route_selection.*DQ_NEIGHBOR/)
})

const channel: ChannelMatrices = {
  R: [[4, .5, .25], [.5, 5, .75], [.25, .75, 6]],
  L: [[9e-9, 2e-9, -1e-9], [2e-9, 16e-9, 3e-9], [-1e-9, 3e-9, 25e-9]],
  C: [[7e-12, -1e-12, -2e-12], [-1e-12, 8e-12, -3e-12], [-2e-12, -3e-12, 9e-12]],
}

const close = (actual: number, expected: number): void => {
  assert.ok(Math.abs(actual - expected) <= Math.max(Math.abs(expected), 1e-30) * 1e-10,
    `expected ${expected}, received ${actual}`)
}

test('three-signal SPICE network reconstructs the complete extracted R, L and C matrices', () => {
  const deck = channelSpice([channel], 1)
  assert.match(deck, /^\.subckt CHANNEL IN0 IN1 IN2 OUT0 OUT1 OUT2 REF$/m)
  const reconstructed: ChannelMatrices = { R: [], L: [], C: [] }
  for (const kind of ['R', 'L', 'C'] as const) reconstructed[kind] = Array.from({ length: 3 }, () => [0, 0, 0])
  for (const line of deck.split('\n')) {
    const [name, , , value] = line.split(' ')
    const self = name.match(/^([RL])0_(\d)$/)
    if (self) reconstructed[self[1] as 'R' | 'L'][Number(self[2])][Number(self[2])] = Number(value)
    const cross = line.match(/^E0_(\d) .*value=\{(.+)\}$/)
    if (cross) for (const term of cross[2].matchAll(/([\deE.+-]+)\*i\(VS0_(\d)\)/g)) {
      reconstructed.R[Number(cross[1])][Number(term[2])] = Number(term[1].replace(/^\+/, ''))
    }
    const capacitor = name.match(/^C([GM])0[ab](\d)(?:_(\d))?$/)
    if (capacitor) {
      const i = Number(capacitor[2]), capacitance = Number(value)
      reconstructed.C[i][i] += capacitance
      if (capacitor[1] === 'M') {
        const j = Number(capacitor[3])
        reconstructed.C[j][j] += capacitance
        reconstructed.C[i][j] -= capacitance
        reconstructed.C[j][i] -= capacitance
      }
    }
  }
  for (const match of deck.matchAll(/^K0_(\d)_(\d) \S+ \S+ (\S+)$/gm)) {
    const i = Number(match[1]), j = Number(match[2])
    reconstructed.L[i][j] = reconstructed.L[j][i] = Number(match[3]) * Math.sqrt(reconstructed.L[i][i] * reconstructed.L[j][j])
  }
  for (const kind of ['R', 'L', 'C'] as const) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    close(reconstructed[kind][i][j], channel[kind][i][j])
  }
})

test('sectioning keeps every mutual and joins each signal to its own next stage', () => {
  const deck = channelSpice([channel, channel], 2)
  assert.equal([...deck.matchAll(/^K\d+_/gm)].length, 12)
  assert.equal([...deck.matchAll(/^E\d+_/gm)].length, 12)
  assert.equal([...deck.matchAll(/^CM\d+/gm)].length, 24)
  for (let section = 0; section < 4; section++) for (let lane = 0; lane < 3; lane++) {
    const before = section === 0 ? `IN${lane}` : `N${section}_${lane}`
    const after = section === 3 ? `OUT${lane}` : `N${section + 1}_${lane}`
    assert.ok(deck.includes(`VS${section}_${lane} ${before} S${section}_${lane} 0\n`))
    const inductance = deck.match(new RegExp(`^L${section}_${lane} L${section}_${lane} ${after} (\\S+)$`, 'm'))
    assert.ok(inductance)
    close(Number(inductance[1]), channel.L[lane][lane] / 2)
  }
})

test('malformed or nonpassive selected matrices fail before emitting a partial channel', () => {
  const differentSize: Matrix = [[1, 0], [0, 1]]
  assert.throws(() => channelSpice([channel, { ...channel, R: differentSize }], 1), /matrix_dimension/)
  assert.throws(() => channelSpice([{ ...channel, L: [[1, 2, 0], [2, 1, 0], [0, 0, 1]] }], 1), /passivity/)
  assert.throws(() => channelSpice([{ ...channel, C: [[3, .1, 0], [.1, 3, 0], [0, 0, 3]] }], 1), /capacitance_sign/)
  assert.throws(() => channelSpice([], 1), /matrix_dimension/)
})
