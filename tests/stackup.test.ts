import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"

// Run the published Node loader: Bun's TSX loader bypasses tsImport's hooks.
test("all examples render a fabrication stackup; strip keeps the declared experiment", () => {
  const result = spawnSync("node", ["--input-type=module", "-e", `
    import assert from 'node:assert/strict'
    import {loadEntry, stackupFromCircuitJson} from 'pcb-spice-pipeline'
    for (const entry of ['index.circuit.tsx', 'examples/ddr-dq/index.circuit.tsx',
      'examples/ddr-dq-strip/index.circuit.tsx', 'examples/single-ended/index.circuit.tsx',
      'examples/differential-data/index.circuit.tsx']) {
      const {circuitJson:circuit, modeling} = await loadEntry(entry)
      const stackup = stackupFromCircuitJson(circuit)
      assert.equal(stackup.copperLayers.length, 4)
      assert.equal(modeling.stackup, undefined)
      if (!entry.includes('ddr-dq-strip')) continue
      assert.equal(modeling.reduction, 'straightened-stages')
      assert.deepEqual(modeling.lanes.map(lane=>[lane.from.port, lane.to.port]), [['M3','E3'],['P1','F3'],['P2','G3']])
      assert.ok(Object.values(modeling.profiles).every(profile=>profile.spacingMm === 0.75))
      const experiments = circuit.filter(record=>record.type === 'simulation_experiment')
      assert.equal(experiments.length, 2)
      assert.ok(experiments.every(record=>Math.abs(record.end_time_ms - 0.00016) < 1e-12 && Math.abs(record.time_per_step - 0.00000001) < 1e-15))
      const eyes = circuit.filter(record=>record.type === 'simulation_eye_diagram')
      assert.equal(eyes.length, 4)
      assert.ok(eyes.every(record=>Math.abs(record.unit_interval_ms - 0.0000025) < 1e-15 && Math.abs(record.start_time_ms - 0.00004) < 1e-12))
      const probe = circuit.find(record=>record.type === 'simulation_voltage_probe' && record.name === 'DQ0_RX')
      const memory = circuit.find(record=>record.type === 'source_component' && record.name === 'U3')
      const memoryPort = name=>circuit.find(record=>record.type === 'source_port' && record.source_component_id === memory.source_component_id && record.name === name).source_port_id
      assert.equal(probe.signal_input_source_port_id, memoryPort('E3'))
      assert.equal(probe.reference_input_source_port_id, memoryPort('B1'))
      assert.equal(modeling.supplies[0].voltageV, 1.5)
    }
  `], { encoding: "utf8", timeout: 180000 })
  expect(result.stderr).toBe("")
  expect(result.status).toBe(0)
}, 190000)
