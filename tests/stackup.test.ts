import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { Circuit } from "@tscircuit/core"
import { stackupFromCircuitJson, type PipelineModeling } from "@tscircuit/pcb-spice-pipeline"
import { serializeSimulation } from "@tscircuit/pcb-spice-pipeline/tsx"
import { any_circuit_element } from "circuit-json"
import { createElement } from "react"
import RootBoard, { modeling as rootModeling } from "../index.circuit"
import DdrBoard, { modeling as ddrModeling } from "../examples/ddr-dq/index.circuit"
import StripBoard, { modeling as stripModeling } from "../examples/ddr-dq-strip/index.circuit"
import CmosBoard, { modeling as cmosModeling } from "../examples/single-ended/index.circuit"
import Rs485Board, { modeling as rs485Modeling } from "../examples/differential-data/index.circuit"
import projectConfig from "../tscircuit.config.json"

const saved = JSON.parse(await readFile(new URL("../am3352.circuit.json", import.meta.url), "utf8"))
const examples = [
  { name: "DDR strobes", Board: RootBoard, modeling: rootModeling, saved: true, counts: [1, 4, 2, 2, 2], timing: [0.0001, 1e-8, 2.5e-6, 2e-5] },
  { name: "routed DDR DQ", Board: DdrBoard, modeling: ddrModeling, saved: true, counts: [2, 12, 6, 6, 4], timing: [0.00016, 1e-8, 2.5e-6, 4e-5] },
  { name: "historical DDR strip", Board: StripBoard, modeling: stripModeling, saved: true, counts: [2, 12, 6, 6, 4], timing: [0.00016, 1e-8, 2.5e-6, 4e-5] },
  { name: "CMOS", Board: CmosBoard, modeling: cmosModeling, saved: false, counts: [1, 2, 1, 2, 2], timing: [0.0016, 5e-8, 5e-5, 0.0002] },
  { name: "RS-485", Board: Rs485Board, modeling: rs485Modeling, saved: false, counts: [1, 4, 2, 2, 2], timing: [0.128, 5e-6, 0.004, 0.016] },
]

for (const example of examples) test(example.name, async () => {
  const modeling: PipelineModeling = example.modeling
  const circuit = new Circuit({ platform: projectConfig.platformConfig })
  circuit.add(createElement(example.Board))
  await circuit.renderUntilSettled()
  const records = serializeSimulation(circuit)
  const stackup = stackupFromCircuitJson(records)
  assert.equal(stackup.copperLayers.length, 4)
  assert.equal("stackup" in modeling, false)
  if (example.saved) {
    // Compare every saved field, including routes, physical IDs and existing diagnostics.
    assert.deepEqual(records.slice(0, saved.length), saved)
    assert.equal(records.length, saved.length + 1 + records.filter(record => record.type.startsWith("simulation_")).length)
  } else {
    assert.deepEqual(records, circuit.getCircuitJson())
    assert.equal(records.filter(record => record.type.endsWith("_error")).length, 0)
  }
  const simulations = records.filter(record => record.type.startsWith("simulation_"))
  for (const record of simulations) any_circuit_element.parse(record)
  const types = ["simulation_experiment", "simulation_ibis_pin_state", "simulation_digital_stimulus",
    "simulation_voltage_probe", "simulation_eye_diagram"]
  assert.deepEqual(types.map(type => simulations.filter(record => record.type === type).length), example.counts)
  assert.equal(simulations.filter(record => record.type === "simulation_ibis_model").length, 2)
  const ids = new Set(records.flatMap(record => Object.entries(record)
    .filter(([key]) => key === `${record.type}_id` || (record.type === "source_group" && key === "subcircuit_id"))
    .map(([, value]) => value)))
  for (const record of simulations) {
    for (const [key, value] of Object.entries(record)) {
      if (key.endsWith("_id") && typeof value === "string") assert.ok(ids.has(value), `${record.type}.${key}: ${value}`)
    }
    const close = (actual: number | undefined, expected: number) => assert.ok(
      actual !== undefined && Math.abs(actual - expected) < 1e-12 * Math.abs(expected), `${record.type}: ${actual} ms, expected ${expected} ms`)
    if (record.type === "simulation_experiment") {
      assert.equal(record.spice_engine, "pcb_spice")
      close(record.end_time_ms, example.timing[0])
      close(record.time_per_step, example.timing[1])
    }
    if (record.type === "simulation_digital_stimulus") close(record.bit_duration_ms, example.timing[2])
    if (record.type === "simulation_eye_diagram") {
      close(record.unit_interval_ms, example.timing[2])
      close(record.start_time_ms, example.timing[3])
    }
  }
  for (const model of simulations.filter(record => record.type === "simulation_ibis_model")) {
    for (const id of Object.values(model.ibis_pin_name_to_source_port_id)) assert.ok(ids.has(id))
    for (const refs of Object.values(model.ibis_pin_name_to_reference_source_port_ids ?? {})) {
      for (const id of Object.values(refs)) assert.ok(ids.has(id))
    }
  }
  if (example.Board === RootBoard || !example.saved || !("supplies" in example.modeling)) return
  const experiments = records.filter(record => record.type === "simulation_experiment")
  assert.deepEqual(experiments.map(record => record.name), ["DDR_QUIET", "DDR_SWITCHING"])
  const memory = records.filter(record => record.type === "source_component").find(record => record.name === "U3")!
  const memoryPort = (name: string) => records.filter(record => record.type === "source_port").find(record => record.source_component_id === memory.source_component_id && record.name === name)!.source_port_id
  const probe = records.filter(record => record.type === "simulation_voltage_probe").find(record => record.name === "DQ0_RX")!
  assert.equal(probe.signal_input_source_port_id, memoryPort("E3"))
  assert.equal(probe.reference_input_source_port_id, memoryPort("B1"))
  assert.equal(example.modeling.supplies[0].voltageV, 1.5)
  if (example.modeling !== stripModeling) return
  assert.equal(example.modeling.reduction, "straightened-stages")
  assert.deepEqual(example.modeling.lanes.map(lane => [lane.from.port, lane.to.port]),
    [["M3", "E3"], ["P1", "F3"], ["P2", "G3"]])
  assert.ok(Object.values(stripModeling.profiles).every(profile => profile.spacingMm === 0.75))
})
