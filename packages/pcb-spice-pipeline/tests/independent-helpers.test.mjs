import test from 'node:test'
import assert from 'node:assert/strict'
import { bitSchedule, sha256 } from '../../../scripts/verification/independent-helpers.mjs'

const stimulus = bits => ({ type: 'simulation_digital_stimulus', bit_duration_ms: 1,
  start_time_ms: 1, initial_state: 0, inverted: false,
  transmission_pattern: { transmission_type: 'bits', bits, repeat: true } })

for (const bits of ['0011', [0, 0, 1, 1]]) {
  test(`independent audit expands canonical ${typeof bits === 'string' ? 'string' : 'array'} bits`, () => {
    const record = stimulus(bits), before = structuredClone(record)
    const value = { initialState: 0, transitions: [{ time: .003, state: 1 }, { time: .005, state: 0 }], duration: .006 }
    assert.deepEqual(bitSchedule(record, 6), { ...value, sha256: sha256(JSON.stringify(value)), explicitRepeatedBits: true })
    assert.deepEqual(record, before)
    const inverted = bitSchedule({ ...record, inverted: true }, 6)
    assert.equal(inverted.initialState, 1)
    assert.deepEqual(inverted.transitions.map(({ state }) => state), [0, 1])
    assert.deepEqual(bitSchedule({ ...record, inverted: true }, 6, 'inverting'), bitSchedule(record, 6))
    assert.throws(() => bitSchedule({ ...record, transmission_pattern: { ...record.transmission_pattern, repeat: false } }, 6), /Nonrepeating data covers experiment/)
    assert.equal(bitSchedule(record, 3).transitions.length, 0, 'data after the experiment does not imply switching')
  })
}

test('independent audit rejects malformed canonical bits', () => {
  for (const bits of ['', [], [0, 2], ['0', '1'], '012']) assert.throws(() => bitSchedule(stimulus(bits), 6))
})
