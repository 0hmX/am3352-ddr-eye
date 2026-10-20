import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { transmittedBits } from "../../packages/pcb-spice-pipeline/dist/stimulus.js"

const [file, scenario] = process.argv.slice(2)
assert.ok(file && ["rs485", "cmos"].includes(scenario), "Usage: node verify-board.mjs CIRCUIT_JSON rs485|cmos")
const cj = JSON.parse(await readFile(file, "utf8"))
const lock = JSON.parse(await readFile(new URL("../vendor-models.lock.json", import.meta.url)))
const vendor = lock.models[scenario]
const settings = {
  rs485: { vccPin: "8", gndPin: "5", durationMs: 0.128, unitIntervalMs: 0.004,
    traceLengthMm: 38.73, stimulusCount: 2, lanes: [["A", "A"], ["B", "B"]],
    signalPins: { TX: { "6": "A", "7": "B" }, RX: { "6": "A", "7": "B" } } },
  cmos: { vccPin: "5", gndPin: "3", durationMs: 0.0016, unitIntervalMs: 0.00005,
    traceLengthMm: 28.45, stimulusCount: 1, lanes: [["Y", "A"]],
    signalPins: { TX: { "4": "Y" }, RX: { "2": "A" } } },
}[scenario]
const modelPath = `models/${vendor.file}`
const sourceBytes = await readFile(new URL(`../../${modelPath}`, import.meta.url))
assert.equal(createHash("sha256").update(sourceBytes).digest("hex"), vendor.sha256, "Prepared IBIS source checksum")
const list = type => cj.filter(x => x.type === type)
const one = (type, predicate) => { const found = list(type).filter(predicate); assert.equal(found.length, 1, type); return found[0] }
const chip = name => one("source_component", x => x.name === name)
const port = (name, hint) => one("source_port", x => x.source_component_id === chip(name).source_component_id &&
  (x.name === hint || x.port_hints?.includes(hint)))
const pcbPort = p => one("pcb_port", x => x.source_port_id === p.source_port_id)
assert.equal(cj.filter(x => x.type.endsWith("_error")).length, 0, "Native rendering errors")
assert.equal(list("simulation_ibis_model").length, 2)
for (const name of ["TX", "RX"]) {
  const model = one("simulation_ibis_model", x => x.source_component_id === chip(name).source_component_id)
  assert.equal(model.ibis_component_name, vendor.component)
  assert.equal(model.include_package_parasitics, false)
  assert.equal(model.model_value_corner, "typical")
  assert.deepEqual(model.ibis_model_asset, {
    project_relative_path: modelPath, url: `./${modelPath}`, mimetype: "text/plain",
  })
  assert.ok(!Object.hasOwn(model, "source"), "Legacy model source is absent")
  const signals = settings.signalPins[name]
  const { vccPin, gndPin } = settings
  for (const [physical, hint] of Object.entries({ ...signals, [vccPin]: "VCC", [gndPin]: "GND" })) {
    const p = port(name, hint)
    assert.equal(p.pin_number, Number(physical), `${name}.${hint}: physical pin`)
    assert.equal(model.ibis_pin_name_to_source_port_id[physical], p.source_port_id)
  }
  for (const physical of Object.keys(signals)) {
    assert.equal(model.ibis_pin_name_to_model_name[physical], vendor.signalPins[physical].model)
    const references = model.ibis_pin_name_to_reference_source_port_ids[physical]
    assert.equal(references.pullup_reference_source_port_id, port(name, "VCC").source_port_id)
    assert.equal(references.pulldown_reference_source_port_id, port(name, "GND").source_port_id)
    assert.equal(references.power_clamp_reference_source_port_id, port(name, "VCC").source_port_id)
    assert.equal(references.ground_clamp_reference_source_port_id, port(name, "GND").source_port_id)
    const state = one("simulation_ibis_pin_state", x => x.source_port_id === model.ibis_pin_name_to_source_port_id[physical])
    assert.equal(state.is_output, name === "TX")
    if (name === "TX") assert.equal(state.is_output_enabled, true)
    else assert.ok(!Object.hasOwn(state, "is_output_enabled"))
  }
}
const lengths = []
for (const [from, to] of settings.lanes) {
  const a = port("TX", from), b = port("RX", to)
  const source = one("source_trace", x => x.connected_source_port_ids?.includes(a.source_port_id) && x.connected_source_port_ids?.includes(b.source_port_id))
  const trace = one("pcb_trace", x => x.source_trace_id === source.source_trace_id)
  const ends = [pcbPort(a), pcbPort(b)], route = trace.route
  const matches = (p, q) => Math.hypot(p.x - q.x, p.y - q.y) < 1e-5
  assert.ok((matches(route[0], ends[0]) && matches(route.at(-1), ends[1])) ||
    (matches(route[0], ends[1]) && matches(route.at(-1), ends[0])), "Physical routed endpoints")
  assert.ok(route.every(p => p.route_type === "wire" && p.layer === "top" && p.width > 0))
  const length = route.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - route[i].x, p.y - route[i].y), 0)
  assert.ok(Math.abs(length - settings.traceLengthMm) < 1e-5, `Unexpected actual route length ${length}`)
  lengths.push(length)
}
const experiment = one("simulation_experiment", x => x.name === "SI")
assert.ok(Math.abs(experiment.end_time_ms - settings.durationMs) < 1e-12)
assert.equal(experiment.spice_engine, "pcb_spice")
assert.ok(!Object.hasOwn(experiment, "execution_mode"))
const controls = list("simulation_digital_stimulus")
assert.equal(controls.length, settings.stimulusCount)
assert.ok(controls.every(x => x.transmission_pattern.transmission_type === "bits"))
const explicitDataBits = controls.map(x => transmittedBits(x.transmission_pattern.bits))
assert.ok(explicitDataBits.every(bits => bits.includes("00") && bits.includes("11")))
assert.ok(controls.every(x => Math.abs(x.bit_duration_ms - settings.unitIntervalMs) < 1e-12))
if (scenario === "rs485") {
  assert.equal(one("simulation_digital_stimulus", x => x.source_port_id === port("TX", "A").source_port_id).inverted, false)
  assert.equal(one("simulation_digital_stimulus", x => x.source_port_id === port("TX", "B").source_port_id).inverted, true)
  assert.equal(chip("RTERM").resistance, 120)
}
assert.equal(list("simulation_voltage_source").length, 1)
assert.equal(list("simulation_eye_diagram").length, 2)
assert.equal(list("simulation_voltage_probe").length, 2)
assert.equal(new Set(list("simulation_eye_diagram").map(x => x.simulation_voltage_probe_id)).size, 2)
console.log(JSON.stringify({ scenario, status: "verified", modelCount: 2, lengthsMm: lengths,
  pcbTraceCount: list("pcb_trace").length, pcbViaCount: list("pcb_via").length,
  sourceSha256: vendor.sha256, explicitDataBits }, null, 2))
