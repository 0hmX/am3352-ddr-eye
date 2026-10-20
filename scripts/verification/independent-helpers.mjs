// Independent evidence readers: no imports from the converter or pipeline.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
export const json = async path => JSON.parse(await readFile(path, 'utf8'))
// Resolve declared supplies independently, including the modeling-side rails
// used with immutable imported PCBs. Every declaration must appear in SPICE.
export async function declaredDcSupplies(out, circuit, nodeMap, deck) {
  const modeling = await json(join(out, 'inputs/modeling.json'))
  const port = selector => {
    const components = selector.sourcePortId ? [] : circuit.filter(record => record.type === 'source_component' && record.name === selector.component)
    if (!selector.sourcePortId) assert.equal(components.length, 1, 'Supply selector identifies one component')
    const ports = circuit.filter(record => record.type === 'source_port' && (selector.sourcePortId
      ? record.source_port_id === selector.sourcePortId
      : record.source_component_id === components[0].source_component_id && (record.name === selector.port || record.port_hints?.includes(selector.port) || `pin${record.pin_number}` === selector.port)))
    assert.equal(ports.length, 1, 'Supply selector identifies one physical port')
    return ports[0].source_port_id
  }
  const physical = circuit.filter(record => record.type === 'simulation_voltage_source').flatMap((source, index) => source.wave_shape ? [] : [{
    name: `VPHYSICAL${index}`, voltageV: source.voltage,
    positive: source.positive_source_port_id ?? source.positive_source_net_id ?? source.terminal1_source_port_id,
    negative: source.negative_source_port_id ?? source.negative_source_net_id ?? source.terminal2_source_port_id,
  }])
  const declared = (modeling.supplies ?? []).map((source, index) => ({name:`VDECLARED${index}`,voltageV:source.voltageV,positive:port(source.positive),negative:port(source.negative)}))
  return [...physical,...declared].map(source => {
    const positiveNode = nodeMap.nodes[source.positive], negativeNode = nodeMap.nodes[source.negative]
    assert.ok(positiveNode && negativeNode && Number.isFinite(source.voltageV), 'Finite supply binds two actual electrical nodes')
    const lines = deck.split(/\r?\n/).map(line => line.trim().split(/\s+/)).filter(parts => parts[0] === source.name)
    assert.equal(lines.length, 1, `Actual SPICE deck contains ${source.name} exactly once`)
    assert.deepEqual(lines[0].slice(1,3),[positiveNode,negativeNode], 'Actual supply has the declared physical polarity')
    close(Number(lines[0][3]),source.voltageV,'Actual supply has the declared DC voltage',1e-12,1e-15)
    return {name:source.name,voltageV:source.voltageV,positiveNode,negativeNode}
  })
}
export function close(actual, expected, label, relative = 1e-9, absolute = 1e-15) {
  assert.ok(Number.isFinite(actual) && Number.isFinite(expected), `${label}: finite values required`)
  assert.ok(Math.abs(actual - expected) <= Math.max(absolute, Math.abs(expected) * relative), `${label}: ${actual} != ${expected}`)
}
export async function inventory(root, prefix = '') {
  const result = {}
  for (const name of (await readdir(join(root, prefix))).sort()) {
    const relative = join(prefix, name)
    if ((await stat(join(root, relative))).isDirectory()) Object.assign(result, await inventory(root, relative))
    else result[relative] = sha256(await readFile(join(root, relative)))
  }
  return result
}

export function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/)
  const headers = lines.shift().split(',')
  const rows = lines.map(line => line.split(',').map(Number))
  assert.ok(rows.length > 0, 'CSV contains samples')
  assert.ok(rows.every(row => row.length === headers.length && row.every(Number.isFinite)), 'Finite CSV values and stable column count')
  return { headers, rows }
}

export function interpolate(timestamps, voltages, time) {
  assert.equal(timestamps.length, voltages.length)
  assert.ok(time >= timestamps[0] && time <= timestamps.at(-1), 'Interpolation uses recorded samples only')
  let lower = 0, upper = timestamps.length - 1
  while (upper - lower > 1) {
    const middle = Math.floor((lower + upper) / 2)
    if (timestamps[middle] <= time) lower = middle
    else upper = middle
  }
  return voltages[lower] + (voltages[upper] - voltages[lower]) * (time - timestamps[lower]) / (timestamps[upper] - timestamps[lower])
}

// Compute integer symbol indices directly instead of copying a runner's loop.
export function completeWindows({ unitInterval, timeOrigin, startTime, endTime, timestamps }) {
  assert.ok(Number.isFinite(unitInterval) && unitInterval > 0)
  assert.ok(Number.isFinite(timeOrigin))
  const lower = Math.max(startTime ?? timestamps[0], timestamps[0])
  const upper = Math.min(endTime ?? timestamps.at(-1), timestamps.at(-1))
  assert.ok(lower <= upper, 'Measurement gate is ordered')
  const first = Math.ceil((lower - timeOrigin) / unitInterval + 0.5 - 1e-10)
  const last = Math.floor((upper - timeOrigin) / unitInterval - 1.5 + 1e-10)
  assert.ok(first <= last, 'At least one complete eye window exists')
  return Array.from({ length: last - first + 1 }, (_, i) => ({
    symbolIndex: first + i,
    start: timeOrigin + (first + i - 0.5) * unitInterval,
    end: timeOrigin + (first + i + 1.5) * unitInterval,
  }))
}

export function strictTimes(timestamps, label) {
  assert.ok(timestamps.length > 1)
  for (let i = 0; i < timestamps.length; i++) {
    assert.ok(Number.isFinite(timestamps[i]), `${label}: finite timestamp`)
    if (i) assert.ok(timestamps[i] > timestamps[i - 1], `${label}: increasing timestamps`)
  }
}

function physical(value) {
  if (typeof value === 'number') return Math.round(value * 1e10) / 1e10
  if (Array.isArray(value)) return value.map(physical)
  if (value?.type === 'pcb_plated_hole' && value.shape === 'circular_hole_with_rect_pad') {
    for (const [key, expected] of [['hole_shape', 'circle'], ['pad_shape', 'rect']]) {
      if (value[key] !== undefined) assert.equal(value[key], expected, `Legacy ${value.shape}: consistent ${key}`)
    }
    value = { ...value, hole_shape: 'circle', pad_shape: 'rect' }
  }
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/_ids?$/.test(key) && !['port_hints', 'subcircuit_connectivity_map_key'].includes(key))
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, physical(key === 'layers' && Array.isArray(item) ? [...item].sort() : item)]))
  return value
}
export function boardGeometry(before, after) {
  const result = []
  for (const type of ['pcb_board', 'pcb_trace', 'pcb_via', 'pcb_smtpad', 'pcb_plated_hole', 'pcb_hole', 'pcb_copper_pour', 'pcb_keepout']) {
    const shapes = elements => elements.filter(element => element.type === type).map(element => sha256(JSON.stringify(physical(element)))).sort()
    const left = shapes(before), right = shapes(after)
    assert.deepEqual(right, left, `${type}: preserved source geometry (IDs and sub-1e-10mm rounding excluded)`)
    result.push({ type, source: left.length, rendered: right.length, preserved: true })
  }
  return result
}

// Only inspect the selected component and model blocks in original vendor bytes.
export function vendorPinEvidence(text, componentName, selected, corner = 'typical') {
  const headers = [...text.matchAll(/^\[([^\]]+)\][ \t]*(.*)$/gm)].map(match => ({ key: match[1].toLowerCase(), value: match[2].trim(), start: match.index, body: match.index + match[0].length }))
  const block = header => text.slice(header.body, headers.find(next => next.start > header.start)?.start ?? text.length)
  const component = headers.find(header => header.key === 'component' && header.value === componentName)
  assert.ok(component, `Exact original component ${componentName}`)
  const componentEnd = headers.find(header => header.key === 'component' && header.start > component.start)?.start ?? text.length
  const pinTable = headers.find(header => header.key === 'pin' && header.start > component.start && header.start < componentEnd)
  assert.ok(pinTable, 'Vendor pin table')
  const pins = block(pinTable).split(/\r?\n/).map(line => line.split('|')[0].trim().split(/\s+/)).filter(row => row.length >= 3)
  const scalar = token => {
    if (!token || /^NA$/i.test(token)) return null
    const match = token.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)([fpnumkKMG]?)(?:[HhFf]|[Oo][Hh][Mm][Ss]?)?$/)
    assert.ok(match, `Known IBIS package numeric token ${token}`)
    const scales = { '': 1, f: 1e-15, p: 1e-12, n: 1e-9, u: 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9 }
    return Number(match[1]) * scales[match[2]]
  }
  const packageHeader = headers.find(header => header.key === 'package' && header.start > component.start && header.start < componentEnd)
  const packageRows = packageHeader ? block(packageHeader).split(/\r?\n/).map(line => line.split('|')[0].trim().split(/\s+/)) : []
  const cornerColumn = { typical: 1, minimum: 2, maximum: 3 }[corner]
  assert.ok(cornerColumn)
  const defaultPackage = ['R_pkg', 'L_pkg', 'C_pkg'].map(key => scalar(packageRows.find(row => row[0]?.toLowerCase() === key.toLowerCase())?.[cornerColumn]))
  const packageValues = row => ({ resistanceOhms: scalar(row[3]) ?? defaultPackage[0], inductanceHenries: scalar(row[4]) ?? defaultPackage[1], capacitanceFarads: scalar(row[5]) ?? defaultPackage[2] })
  const evidence = []
  for (const { physicalPin, model, localPort, mode } of selected) {
    const row = pins.find(pin => pin[0] === physicalPin)
    assert.ok(row, `Vendor physical pin ${physicalPin}`)
    if (!model) {
      assert.ok(['POWER', 'GND'].includes(row[2].toUpperCase()), 'Mapped supply pin is marked POWER/GND')
      evidence.push({ physicalPin, localPort, signal: row[1], supplyType: row[2], package: packageValues(row) })
      continue
    }
    let selectorChoice = null
    if (row[2] !== model) {
      const selector = headers.find(header => header.key === 'model selector' && header.value === row[2])
      assert.ok(selector, `Vendor selector ${row[2]}`)
      selectorChoice = block(selector).split(/\r?\n/).find(line => line.trim().split(/\s+/)[0] === model)?.trim()
      assert.ok(selectorChoice, `${model} belongs to the pin's vendor selector`)
    }
    const modelHeader = headers.find(header => header.key === 'model' && header.value === model)
    assert.ok(modelHeader, `Vendor electrical model ${model}`)
    const modelBody = block(modelHeader)
    const modelType = modelBody.match(/^Model_type[ \t]+([^\r\n]+)/mi)?.[1].trim().toLowerCase()
    const polarity = modelBody.match(/^Polarity[ \t]+([^\r\n]+)/mi)?.[1].trim()
    const enable = modelBody.match(/^Enable[ \t]+([^\r\n]+)/mi)?.[1].trim()
    if (mode === 'output') assert.ok(['output', 'i/o', '3-state'].includes(modelType), 'Output role is vendor-compatible')
    if (mode === 'input') assert.ok(['input', 'i/o', '3-state', 'terminator'].includes(modelType), 'Input role is vendor-compatible')
    evidence.push({ physicalPin, localPort, signal: row[1], pinModelOrSelector: row[2], selectedModel: model, modelType, polarity, enable, selectorChoice, package: packageValues(row) })
  }
  return evidence
}

// Use native Circuit JSON milliseconds and enumerate bit boundaries directly.
export function bitSchedule(stimulus, durationMs, vendorPolarity) {
  const pattern = stimulus.transmission_pattern
  assert.equal(pattern.transmission_type, 'bits')
  assert.equal(typeof pattern.repeat, 'boolean')
  if (Array.isArray(pattern.bits)) assert.ok(pattern.bits.length && Array.from(pattern.bits).every(bit => bit === 0 || bit === 1), 'Numeric binary bits')
  const bits = Array.isArray(pattern.bits) ? pattern.bits.join('') : pattern.bits
  assert.equal(typeof bits, 'string')
  assert.match(bits, /^[01]+$/)
  const interval = stimulus.bit_duration_ms * 1e-3
  const start = stimulus.start_time_ms * 1e-3
  const duration = durationMs * 1e-3
  assert.ok(interval > 0 && start >= 0 && start < duration)
  const complement = Boolean(stimulus.inverted) !== (vendorPolarity === 'inverting')
  const padState = logical => complement ? 1 - logical : logical
  const initialState = padState(stimulus.initial_state)
  const transitions = []
  let previous = initialState
  for (let bit = 0; start + bit * interval < duration - interval * 1e-12; bit++) {
    assert.ok(bit < 100000, 'Bounded explicit bit expansion')
    assert.ok(pattern.repeat || bit < bits.length, 'Nonrepeating data covers experiment')
    const state = padState(Number(bits[bit % bits.length]))
    if (state !== previous) transitions.push({ time: start + bit * interval, state })
    previous = state
  }
  const value = { initialState, transitions, duration }
  return { ...value, sha256: sha256(JSON.stringify(value)), explicitRepeatedBits: /00|11/.test(bits) }
}
