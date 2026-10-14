import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

const [file, scenario] = process.argv.slice(2)
assert.ok(file && ["rs485", "cmos"].includes(scenario), "Usage: node verify-board.mjs CIRCUIT_JSON rs485|cmos")
const cj = JSON.parse(await readFile(file, "utf8"))
const lock = JSON.parse(await readFile(new URL("../vendor-models.lock.json", import.meta.url)))
const vendor = lock.models[scenario === "rs485" ? "rs485" : "cmos"]
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
  assert.equal(model.component, vendor.component)
  assert.equal(model.package_policy, "omit")
  assert.equal(model.source.sha256, vendor.sha256)
  assert.equal(model.source.archive.sha256, vendor.archiveSha256)
  const signals = scenario === "rs485" ? { "6": "A", "7": "B" } : name === "TX" ? { "4": "Y" } : { "2": "A" }
  const vccPin = scenario === "rs485" ? "8" : "5", gndPin = scenario === "rs485" ? "5" : "3"
  for (const [physical, hint] of Object.entries({ ...signals, [vccPin]: "VCC", [gndPin]: "GND" })) {
    const p = port(name, hint)
    assert.equal(p.pin_number, Number(physical), `${name}.${hint}: physical pin`)
    assert.equal(model.pin_to_source_port_map[physical], p.source_port_id)
  }
  for (const physical of Object.keys(signals)) {
    assert.equal(model.model_selections[physical], vendor.signalPins[physical].model)
    assert.equal(model.references[physical].pullup, port(name, "VCC").source_port_id)
    assert.equal(model.references[physical].pulldown, port(name, "GND").source_port_id)
    assert.equal(model.references[physical].power_clamp, port(name, "VCC").source_port_id)
    assert.equal(model.references[physical].ground_clamp, port(name, "GND").source_port_id)
    const state = one("simulation_ibis_pin_state", x => x.source_port_id === model.pin_to_source_port_map[physical])
    assert.equal(state.mode, name === "TX" ? "output" : "input")
    if (name === "TX") assert.equal(state.enabled, true)
  }
}
const lanes = scenario === "rs485" ? [["A", "A"], ["B", "B"]] : [["Y", "A"]]
const lengths = []
for (const [from, to] of lanes) {
  const a = port("TX", from), b = port("RX", to)
  const source = one("source_trace", x => x.connected_source_port_ids?.includes(a.source_port_id) && x.connected_source_port_ids?.includes(b.source_port_id))
  const trace = one("pcb_trace", x => x.source_trace_id === source.source_trace_id)
  const ends = [pcbPort(a), pcbPort(b)], route = trace.route
  const matches = (p, q) => Math.hypot(p.x - q.x, p.y - q.y) < 1e-5
  assert.ok((matches(route[0], ends[0]) && matches(route.at(-1), ends[1])) ||
    (matches(route[0], ends[1]) && matches(route.at(-1), ends[0])), "Physical routed endpoints")
  assert.ok(route.every(p => p.route_type === "wire" && p.layer === "top" && p.width > 0))
  const length = route.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - route[i].x, p.y - route[i].y), 0)
  assert.ok(Math.abs(length - (scenario === "rs485" ? 38.73 : 28.45)) < 1e-5, `Unexpected actual route length ${length}`)
  lengths.push(length)
}
const experiment = one("simulation_experiment", x => x.name === "SI")
assert.ok(Math.abs(experiment.end_time_ms - (scenario === "rs485" ? 0.128 : 0.0016)) < 1e-12)
const controls = list("simulation_digital_stimulus")
assert.equal(controls.length, scenario === "rs485" ? 2 : 1)
assert.ok(controls.every(x => x.pattern.bits.includes("00") && x.pattern.bits.includes("11")))
assert.ok(controls.every(x => Math.abs(x.unit_interval_ms - (scenario === "rs485" ? 0.004 : 0.00005)) < 1e-12))
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
  sourceSha256: vendor.sha256, explicitDataBits: controls.map(x => x.pattern.bits) }, null, 2))
