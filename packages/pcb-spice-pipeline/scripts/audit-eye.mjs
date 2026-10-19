// Independent checks: intentionally does not import pipeline/metrics/extraction code.
import assert from 'node:assert/strict'
import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { gunzipSync, inflateRawSync } from 'node:zlib'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hostname, platform, arch } from 'node:os'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const readJson = async path => JSON.parse(await readFile(path, 'utf8'))
const close = (actual, expected, label, relative = 1e-10, absolute = 1e-15) =>
  assert.ok(Math.abs(actual - expected) <= Math.max(absolute, Math.abs(expected) * relative), `${label}: ${actual} != ${expected}`)

async function fileHashes(root, prefix = '') {
  const result = {}
  for (const name of (await readdir(join(root, prefix))).sort()) {
    const path = join(prefix, name)
    if ((await stat(join(root, path))).isDirectory()) Object.assign(result, await fileHashes(root, path))
    else if (path !== 'receipt.json') result[path] = hash(await readFile(join(root, path)))
  }
  return result
}

// Decode the locked ZIP member with Node's zlib, independently of fflate used by the pipeline.
function zipMember(bytes, requested) {
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) !== 0x06054b50) continue
    let p = bytes.readUInt32LE(i + 16)
    const count = bytes.readUInt16LE(i + 10)
    for (let n = 0; n < count; n++) {
      assert.equal(bytes.readUInt32LE(p), 0x02014b50, 'ZIP central directory')
      const method = bytes.readUInt16LE(p + 10), length = bytes.readUInt32LE(p + 20)
      const nameLength = bytes.readUInt16LE(p + 28), extraLength = bytes.readUInt16LE(p + 30), commentLength = bytes.readUInt16LE(p + 32)
      const name = bytes.subarray(p + 46, p + 46 + nameLength).toString('utf8')
      if (name === requested) {
        const local = bytes.readUInt32LE(p + 42)
        assert.equal(bytes.readUInt32LE(local), 0x04034b50, 'ZIP local header')
        const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28)
        const compressed = bytes.subarray(start, start + length)
        assert.ok(method === 0 || method === 8, 'Supported locked ZIP compression')
        return method === 0 ? compressed : inflateRawSync(compressed)
      }
      p += 46 + nameLength + extraLength + commentLength
    }
    throw new Error(`ZIP member missing: ${requested}`)
  }
  throw new Error('ZIP end record missing')
}

function independentlyCheckIbisPins(text, config) {
  const headers = [...text.matchAll(/^\[([^\]]+)\][ \t]*(.*)$/gm)].map(m => ({ key: m[1].toLowerCase(), value: m[2].trim(), index: m.index, end: m.index + m[0].length }))
  const block = h => text.slice(h.end, headers.find(next => next.index > h.index)?.index ?? text.length)
  const component = headers.find(h => h.key === 'component' && h.value === config.component)
  assert.ok(component, `IBIS component ${config.component} exists`)
  const end = headers.find(h => h.key === 'component' && h.index > component.index)?.index ?? text.length
  const pinHeader = headers.find(h => h.key === 'pin' && h.index > component.index && h.index < end)
  assert.ok(pinHeader, 'Original IBIS pin table exists')
  const rows = block(pinHeader).split(/\r?\n/).map(l => l.split('|')[0].trim().split(/\s+/)).filter(r => r.length >= 3)
  const pins = Object.entries(config.pins).map(([port, selection]) => {
    const pin = rows.find(r => r[0] === selection.pin)
    assert.ok(pin, `Original vendor physical pin ${selection.pin}`)
    let description = null
    if (pin[2] !== selection.model) {
      const selector = headers.find(h => h.key === 'model selector' && h.value === pin[2])
      assert.ok(selector, `Original selector ${pin[2]} exists`)
      const choice = block(selector).split(/\r?\n/).find(l => l.trim().split(/\s+/)[0] === selection.model)
      assert.ok(choice, `Selected ${selection.model} is a valid choice for physical pin ${selection.pin}`)
      description = choice.trim()
    }
    const model = headers.find(h => h.key === 'model' && h.value === selection.model)
    assert.ok(model, `Original electrical model ${selection.model}`)
    const type = block(model).match(/^Model_type[ \t]+(.+)$/mi)?.[1].trim().toLowerCase()
    assert.ok(selection.mode === 'input' ? type === 'input' : ['output', 'i/o', '3-state'].includes(type), 'Selected pin direction agrees with vendor model type')
    return { port, physicalPin: selection.pin, vendorSignalName: pin[1], pinModelOrSelector: pin[2], selectedModel: selection.model, modelType: type, selectorDescription: description, packageModel: config.packageModel }
  })
  const powerPins = Object.entries(config.power).map(([role, physicalPin]) => {
    const pin = rows.find(row => row[0] === physicalPin)
    assert.ok(pin, `Actual vendor ${role} physical supply pin ${physicalPin}`)
    assert.equal(pin[2].toUpperCase(), role === 'vdd' ? 'POWER' : 'GND', `Vendor supply type for ${physicalPin}`)
    return { role, physicalPin, vendorSignalName: pin[1], type: pin[2] }
  })
  return { pins, powerPins }
}

function csvRows(text) {
  const lines = text.trim().split(/\r?\n/)
  assert.equal(lines.shift(), 'time_s,driver_p_v,driver_n_v,receiver_p_v,receiver_n_v,receiver_diff_v,driver_diff_v')
  const rows = lines.map(line => line.split(',').map(Number))
  assert.ok(rows.length > 100)
  for (const [i, row] of rows.entries()) {
    assert.ok(row.length === 7 && row.every(Number.isFinite), 'Finite seven-column waveform')
    if (i) assert.ok(row[0] > rows[i - 1][0], 'Strictly increasing time')
    // ngspice's wrdata decimal rounding occurs independently in the difference columns.
    close(row[5], row[3] - row[4], 'Receiver differential', 2e-6, 2e-7)
    close(row[6], row[1] - row[2], 'Driver differential', 2e-6, 2e-7)
  }
  return rows
}

function zeroCrossings(rows, column, after) {
  const result = []
  for (let i = 1; i < rows.length; i++) {
    const left = rows[i - 1], right = rows[i]
    if (right[0] < after || left[column] * right[column] >= 0) continue
    const fraction = -left[column] / (right[column] - left[column])
    result.push({ time: left[0] + fraction * (right[0] - left[0]), rising: right[column] > left[column] })
  }
  return result
}

function interpolated(rows, time, column) {
  let lo = 0, hi = rows.length - 1
  assert.ok(time >= rows[0][0] && time <= rows[hi][0], 'Interpolation within measured samples')
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (rows[mid][0] < time) lo = mid; else hi = mid }
  const a = rows[lo], b = rows[hi]
  return a[column] + (b[column] - a[column]) * (time - a[0]) / (b[0] - a[0])
}

export function independentMetrics(rows, simulation, eye = { differentialColumn: 5, polarity: 1, endpoint: 'receiver' }) {
  const ui = simulation.uiSeconds, after = simulation.excludeSeconds
  const receiver = zeroCrossings(rows, 5, after), driver = zeroCrossings(rows, 6, after)
  const selected = rows.map(row => { const r = [...row]; r[5] = row[eye.differentialColumn] * eye.polarity; return r })
  const eyeCrossings = zeroCrossings(selected, 5, after)
  assert.ok(receiver.length >= 8 && driver.length >= 8, 'Actual transitions present')
  const delays = []
  for (const crossing of receiver) {
    let matched
    for (const source of driver) if (source.rising === crossing.rising && source.time <= crossing.time && crossing.time - source.time < ui) matched = source
    if (matched) delays.push(crossing.time - matched.time)
  }
  delays.sort((a, b) => a - b)
  assert.ok(delays.length >= 8)
  const centers = [], phase = eyeCrossings[0].time
  for (let i = 0, t = phase + ui / 2; t < rows.at(-1)[0]; i++, t += ui)
    centers.push({ time: t, value: interpolated(selected, t, 5), high: i % 2 === 0 ? eyeCrossings[0].rising : !eyeCrossings[0].rising })
  const high = centers.filter(s => s.high).map(s => s.value), low = centers.filter(s => !s.high).map(s => s.value)
  const intervals = eyeCrossings.slice(1).map((c, i) => c.time - eyeCrossings[i].time)
  const steady = selected.filter(r => r[0] >= after).map(r => r[5])
  return {
    samples: rows.length, receiverTransitions: receiver.length, eyePhaseSeconds: phase,
    eyeHeightAtCenterV: Math.min(...high) - Math.max(...low),
    propagationMedianSeconds: delays[Math.floor(delays.length / 2)],
    propagationRangeSeconds: [delays[0], delays.at(-1)],
    crossingIntervalRangeSeconds: [Math.min(...intervals), Math.max(...intervals)],
    differentialRangeV: [Math.min(...steady), Math.max(...steady)],
    simulatedDurationSeconds: rows.at(-1)[0], centerSamples: centers,
  }
}

const physicalRoute = route => route.map(p => Object.fromEntries(Object.entries(p).filter(([key]) => !key.endsWith('_id')).sort(([a], [b]) => a.localeCompare(b))))

function physicalGeometry(value) {
  if (typeof value === 'number') return Math.round(value * 1e10) / 1e10
  if (Array.isArray(value)) return value.map(physicalGeometry)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/_ids?$/.test(key) && !['port_hints', 'subcircuit_connectivity_map_key'].includes(key))
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, physicalGeometry(key === 'layers' && Array.isArray(child) ? [...child].sort() : child)]))
  return value
}

export function independentlyCheckBoardGeometry(original, circuit) {
  const inventory = []
  for (const type of ['pcb_board', 'pcb_via', 'pcb_smtpad', 'pcb_plated_hole', 'pcb_hole', 'pcb_copper_pour', 'pcb_keepout']) {
    const shapes = cj => cj.filter(e => e.type === type).map(e => hash(JSON.stringify(physicalGeometry(e)))).sort()
    const before = shapes(original), after = shapes(circuit)
    assert.ok(JSON.stringify(before) === JSON.stringify(after), `${type}: original ${before.length}, native ${after.length}; changed/omitted physical geometry detected (ID remapping and <1e-10mm rounding ignored)`)
    inventory.push({ type, original: before.length, native: after.length, physicalGeometryPreserved: true })
  }
  const manualVias = cj => cj.filter(e => e.type === 'source_manually_placed_via').length
  assert.equal(manualVias(circuit), manualVias(original), 'Every manually placed source via preserved')
  const references = cj => {
    const ports = new Map(cj.filter(e => e.type === 'pcb_port').map(e => [e.pcb_port_id, e]))
    const pours = new Set(cj.filter(e => e.type === 'pcb_copper_pour').map(e => e.pcb_copper_pour_id))
    let endpoints = 0, offsets = 0, pourReferences = 0
    for (const trace of cj.filter(e => e.type === 'pcb_trace')) for (const point of trace.route) {
      if (point.copper_pour_id) { pourReferences++; assert.ok(pours.has(point.copper_pour_id), 'No dangling copper-pour pointer') }
      for (const key of ['start_pcb_port_id', 'end_pcb_port_id']) if (point[key]) {
        endpoints++
        const port = ports.get(point[key])
        assert.ok(port, 'No dangling physical endpoint pointer')
        if (Math.hypot(port.x - point.x, port.y - point.y) > 1e-5) offsets++
      }
    }
    return { endpointReferences: endpoints, originalRouteEndpointsOffsetFromPadCenter: offsets, copperPourReferences: pourReferences }
  }
  const originalReferences = references(original), nativeReferences = references(circuit)
  assert.deepEqual(nativeReferences, originalReferences, 'Reference metadata preserves original draft, including inherited pad-center offsets')
  return { inventory, manualViasPreserved: manualVias(circuit), references: nativeReferences, coordinateComparisonResolutionMm: 1e-10 }
}

const symmetric = matrix => matrix.map((row, i) => row.map((value, j) => (value + matrix[j][i]) / 2))
function positiveEnergy(matrix, name) {
  const factors = matrix.map(row => row.map(() => 0))
  for (let i = 0; i < matrix.length; i++) for (let j = 0; j <= i; j++) {
    let residual = matrix[i][j]
    for (let k = 0; k < j; k++) residual -= factors[i][k] * factors[j][k]
    if (i === j) {
      assert.ok(Number.isFinite(residual) && residual > 0, `${name}: positive energy/loss pivot`)
      factors[i][j] = Math.sqrt(residual)
    } else factors[i][j] = residual / factors[j][j]
  }
}

export async function independentlyCheckMatrices(out, cell, modeling) {
  const routed = modeling.reduction === 'routed-copper' || Boolean(cell.routedCopper)
  const capacitanceScaleToFarads = routed ? 1e-3 : 1
  const stage = join(out, `stage-${cell.stage}`)
  const extraction = await readJson(join(stage, 'extraction.json'))
  const list = await readFile(join(stage, 'channel.lst'), 'utf8')
  assert.match(list.split(/\r?\n/)[0], routed ? /\bmillimetres\b/ : /\bmetres\b/, 'Captured FasterCap deck declares the independently expected coordinate units')
  if (routed) for (const conductor of cell.conductors) {
    const panel = await readFile(join(stage, `${conductor.name}.txt`), 'utf8')
    assert.match(panel.split(/\r?\n/)[0], /\bmillimetres\b/, 'Actual routed FasterCap panels use mm')
  }
  const raw = await readFile(join(stage, 'refinement/Zc.mat'), 'utf8')
  const marker = raw.match(/Impedance matrix for frequency\s*=\s*(\S+)\s+(\d+)\s+x\s+(\d+)\s*\n/)
  assert.ok(marker, 'Raw refined FastHenry matrix')
  const frequency = Number(marker[1]), dimension = Number(marker[2])
  assert.equal(Number(marker[3]), dimension)
  assert.equal(dimension, cell.conductors.length, 'Raw solver conductor count agrees with generated geometry')
  assert.ok([2, 3, 4].includes(dimension), 'Backend contains one to three signals plus a return')
  close(frequency, modeling.extraction.modelHz, 'Executed field-solver frequency')
  const complex = raw.slice(marker.index + marker[0].length).trim().split(/\r?\n/).slice(0, dimension)
    .map(line => line.trim().split(/\s+/).map(token => Number(token.replace(/j$/, ''))))
  assert.ok(complex.length === dimension && complex.every(row => row.length === 2 * dimension && row.every(Number.isFinite)))
  const primitiveR = complex.map(row => Array.from({ length: dimension }, (_, i) => row[2 * i]))
  const primitiveL = complex.map(row => Array.from({ length: dimension }, (_, i) => row[2 * i + 1] / (2 * Math.PI * frequency)))
  const returnIndex = dimension - 1
  const loops = primitive => Array.from({ length: returnIndex }, (_, i) => Array.from({ length: returnIndex }, (_, j) =>
    primitive[i][j] - primitive[i][returnIndex] - primitive[returnIndex][j] + primitive[returnIndex][returnIndex]))
  const R = symmetric(loops(primitiveR)), L = symmetric(loops(primitiveL))

  const capText = await readFile(join(stage, 'fastercap.stdout.log'), 'utf8')
  const capMarker = [...capText.matchAll(/Capacitance matrix is:\s*\nDimension\s+(\d+)\s+x\s+(\d+)\s*\n/g)].at(-1)
  assert.ok(capMarker, 'Final raw FasterCap capacitance matrix')
  assert.equal(Number(capMarker[1]), dimension)
  assert.equal(Number(capMarker[2]), dimension)
  const capLines = capText.slice(capMarker.index + capMarker[0].length).trim().split(/\r?\n/).slice(0, dimension).map(line => line.trim().split(/\s+/))
  assert.ok(capLines.every((row, i) => row[0].endsWith(`_${cell.conductors[i].name}`)), 'Actual capacitance conductor ordering')
  assert.ok(capLines.every(row => row.length === dimension + 1 && row.slice(1).every(value => Number.isFinite(Number(value)))), 'Finite raw capacitance matrix')
  // Routed-copper panels use numeric mm to avoid FasterCap's absolute area
  // thresholds. Electrostatic C scales with length; the legacy panels use m.
  // Derive the conversion from the captured input/geometry, not result metadata.
  const primitiveC = symmetric(capLines.map(row => row.slice(1).map(value => Number(value) * capacitanceScaleToFarads)))
  assert.equal(extraction.conversions.capacitanceScaleToFarads, capacitanceScaleToFarads, 'Reported capacitance scale agrees with input geometry')
  assert.equal(extraction.conversions.capacitanceSolverCoordinateUnits, routed ? 'mm' : 'm', 'Reported capacitance units agree with captured panels')
  const rowSums = primitiveC.map(row => row.reduce((sum, value) => sum + value, 0))
  const total = rowSums.reduce((sum, value) => sum + value, 0)
  assert.ok(total > 0, 'Finite reference-reduction capacitance')
  const C = Array.from({ length: returnIndex }, (_, i) => Array.from({ length: returnIndex }, (_, j) => primitiveC[i][j] - rowSums[i] * rowSums[j] / total))
  for (const [kind, matrix] of Object.entries({ R, L, C })) {
    positiveEnergy(matrix, kind)
    assert.equal(extraction[kind].length, returnIndex)
    matrix.forEach((row, i) => row.forEach((value, j) => close(value, extraction[kind][i][j], `Independent raw-solver ${kind}[${i}][${j}]`, 1e-10, kind === 'C' ? 1e-23 : kind === 'L' ? 1e-20 : 1e-12)))
  }
  assert.ok(Number.isFinite(modeling.conductivitySm) && modeling.conductivitySm > 0, 'Finite positive copper conductivity')
  const dcResistanceOhm = routed ? cell.routedCopper.signals.map(signal => signal.segments.reduce((resistance, segment) => {
    assert.ok([segment.a, segment.b].every(point => point.length === 3 && point.every(Number.isFinite)), 'Finite routed segment endpoints in mm')
    assert.ok([segment.widthMm, segment.thicknessMm].every(value => Number.isFinite(value) && value > 0), 'Positive routed signal cross-section')
    const lengthM = Math.hypot(...segment.a.map((value, axis) => value - segment.b[axis])) * 1e-3
    const areaM2 = segment.widthMm * 1e-3 * segment.thicknessMm * 1e-3
    assert.ok(lengthM > 0, 'Positive routed signal segment length')
    return resistance + lengthM / (modeling.conductivitySm * areaM2)
  }, 0)) : cell.conductors.map(conductor => conductor.lengthM / (modeling.conductivitySm * conductor.widthM * conductor.thicknessM))
  assert.equal(dcResistanceOhm.length, routed ? returnIndex : dimension, 'DC analytic check covers every supported conductor')
  assert.equal(extraction.checks.analyticResistanceOhm.length, dcResistanceOhm.length, 'Reported DC analytic check has the expected signal/return coverage')
  dcResistanceOhm.forEach((value, i) => close(value, extraction.checks.analyticResistanceOhm[i], 'Geometry DC resistance independently recomputed'))
  const groundDcResistanceCheck = routed
    ? { status: 'not-applicable', reason: 'A polygon ground plane has no uniform-bar length/width; l/(sigma*w*t) applies only to each routed signal segment. Ground-plane accuracy requires mesh refinement.' }
    : { status: 'checked', resistanceOhm: dcResistanceOhm[returnIndex] }
  return { stage: cell.stage, signalConductors: returnIndex, modelFrequencyHz: frequency, capacitanceScaleToFarads, R, L, C, independentDcResistanceOhm: dcResistanceOhm, groundDcResistanceCheck }
}

export async function auditRun(outputDir, { fixture = new URL('../examples/fixtures/am3352.circuit.json.gz', import.meta.url), sourceRoot = null } = {}) {
  const out = resolve(outputDir), receipt = await readJson(join(out, 'receipt.json'))
  assert.equal(receipt.status, 'executed')
  assert.equal(receipt.execution.solverResultCache, false, 'Fresh executed solver results')
  assert.equal(receipt.execution.host, hostname(), 'Run executed on current local host')
  assert.equal(receipt.execution.platform, platform(), 'Run platform is current native host')
  assert.equal(receipt.execution.architecture, arch(), 'Run architecture is current native host')
  const recomputed = await fileHashes(out)
  assert.deepEqual(recomputed, receipt.files, 'Every generated file hash and file list')
  let sourceFilesIndependentlyHashed = 0
  if (sourceRoot) for (const [path, digest] of Object.entries(receipt.sourceFiles)) {
    assert.equal(hash(await readFile(join(sourceRoot, path))), digest, `Exact source/config/package hash: ${path}`)
    sourceFilesIndependentlyHashed++
  }
  const circuitBytes = await readFile(join(out, 'inputs/circuit.json'))
  assert.equal(hash(circuitBytes), receipt.sourceCircuitJsonSha256, 'Executed circuit bytes match receipt')
  const circuit = JSON.parse(circuitBytes), modeling = await readJson(join(out, 'inputs/modeling.json'))
  const geometry = await readJson(join(out, 'geometry.json'))
  const original = gunzipSync(await readFile(fixture)), originalCircuit = JSON.parse(original)
  assert.equal(hash(original), modeling.fixtureProvenance.originalJsonSha256, 'Pinned original board bytes')
  const boardGeometryAudit = independentlyCheckBoardGeometry(originalCircuit, circuit)
  const routedShapes = cj => cj.filter(e => e.type === 'pcb_trace').map(e => hash(JSON.stringify(physicalRoute(e.route)))).sort()
  const originalShapes = routedShapes(originalCircuit), actualShapes = routedShapes(circuit)
  assert.ok(JSON.stringify(actualShapes) === JSON.stringify(originalShapes), `Every saved PCB trace geometry must be preserved: original ${originalShapes.length}, native ${actualShapes.length}; rerouting or omission detected`)
  const routeAudit = geometry.mappings.map((mapping, index) => {
    const lane = modeling.lanes[index]
    const originalPinMapping = modeling.sourceProvenance?.pinMappings.find(p => p.source.pin === lane.driverPort && p.receiver.pin === lane.receiverPort)
    const originalTraceId = originalPinMapping?.sourceTraceId ?? mapping.sourceTraceId
    const candidates = originalCircuit.filter(e => e.type === 'pcb_trace' && e.source_trace_id === originalTraceId)
    assert.equal(candidates.length, 1, 'Route exists in original board')
    assert.deepEqual(physicalRoute(mapping.originalRoute), physicalRoute(candidates[0].route), 'All original route coordinates/layers/widths/vias preserved')
    const generated = circuit.find(e => e.type === 'pcb_trace' && e.pcb_trace_id === mapping.pcbTraceId)
    assert.ok(generated, 'Selected route exists in executed Circuit JSON')
    assert.deepEqual(physicalRoute(generated.route), physicalRoute(candidates[0].route), 'TSX-imported route preserves original geometry')
    return { sourceTraceId: mapping.sourceTraceId, originalSourceTraceId: originalTraceId, vertices: mapping.originalRoute.length, stageLengthsMm: mapping.stages.map(s => s.lengthMm) }
  })
  const vendors = []
  for (const [index, lock] of modeling.vendors.entries()) {
    const bytes = await readFile(join(out, 'inputs', lock.file))
    const archive = await readFile(join(out, 'inputs', `${lock.vendor.replaceAll(' ', '-')}.zip`))
    assert.equal(hash(bytes), lock.sha256, 'Original IBIS hash')
    assert.equal(hash(archive), lock.archiveSha256, 'Vendor archive hash')
    assert.equal(hash(zipMember(archive, lock.archivePath)), hash(bytes), 'IBIS bytes decoded independently from original archive')
    const pinEvidence = independentlyCheckIbisPins(bytes.toString('utf8'), index === 0 ? modeling.driver : modeling.receiver)
    vendors.push({ vendor: lock.vendor, file: lock.file, ibisSha256: hash(bytes), archiveSha256: hash(archive), ...pinEvidence })
  }
  const deck = await readFile(join(out, 'simulation.cir'), 'utf8')
  assert.match(deck, /^XCHAN drv0 drv1 rx0 rx1 0 CHANNEL$/m, 'Four distinct source/receiver pads')
  for (const role of ['driver', 'receiver']) {
    assert.equal(receipt.nativeIbis[role].usedNativeSourceForSimulation, true, 'Native chip model executed')
    assert.equal(receipt.nativeIbis[role].sourceEqualsIndependentConversion, true)
    assert.ok(deck.includes(await readFile(join(out, `${role}.lib`), 'utf8')), 'Actual native buffer source in executed deck')
  }
  const commands = []
  for (const path of Object.keys(receipt.files).filter(p => p.endsWith('.command.json'))) {
    const command = await readJson(join(out, path))
    assert.equal(command.exitCode, 0, `Executed command ${path}`)
    assert.equal(resolve(command.cwd), dirname(join(out, path)), 'Native command executed in fresh output directory')
    commands.push({ path, executable: command.executable, args: command.args, exitCode: command.exitCode })
  }
  assert.ok(commands.some(c => c.path === 'ngspice.command.json' && c.args.includes('simulation.cir')), 'ngspice actually executed')
  for (const stage of geometry.cells) {
    for (const command of ['fasthenry.command.json', 'refinement/fasthenry.command.json', 'fastercap.command.json'])
      assert.ok(commands.some(c => c.path === `stage-${stage.stage}/${command}`), `Fresh solver stage ${stage.stage}/${command}`)
  }
  const binaryAudit = []
  for (const name of ['fasthenry', 'fastercap', 'ngspice']) {
    const evidence = receipt.toolEvidence[name]
    assert.equal(evidence.platform, receipt.execution.platform)
    assert.equal(evidence.host, receipt.execution.host)
    assert.equal(hash(await readFile(evidence.executable)), evidence.sha256, 'Executed native binary hash')
    binaryAudit.push({ name, ...evidence })
  }
  const matrixAudit = []
  for (const cell of geometry.cells) matrixAudit.push(await independentlyCheckMatrices(out, cell, modeling))
  const rows = csvRows(await readFile(join(out, 'waveform.csv'), 'utf8'))
  const eye = await readJson(join(out, 'eyediagram.json'))
  assert.equal(eye.origin, 'native-tsx-element', 'Native TSX element used')
  assert.deepEqual(eye, receipt.eyeDiagram, 'Eye record matches receipt')
  assert.ok(['driver', 'receiver'].includes(eye.endpoint), 'Native eye endpoint selected')
  assert.ok([1, -1].includes(eye.polarity), 'Native eye polarity selected')
  for (const [key, field] of [['unitIntervalSeconds', 'uiSeconds'], ['durationSeconds', 'durationSeconds'], ['timeStepSeconds', 'stepSeconds'], ['startTimeSeconds', 'excludeSeconds']])
    close(eye[key], modeling.simulation[field], `Native eyediagram.${key} controls actual simulation`)
  const tran = deck.match(/^tran\s+(\S+)\s+(\S+)\s+0\s+(\S+)$/m)
  assert.ok(tran, 'Executed transient instruction')
  close(Number(tran[1]), eye.timeStepSeconds, 'Executed tran step controlled by element')
  close(Number(tran[2]), eye.durationSeconds, 'Executed tran duration controlled by element')
  close(Number(tran[3]), eye.timeStepSeconds, 'Executed tran maximum step controlled by element')
  const endpointField = eye.endpoint === 'receiver' ? 'to' : 'from'
  const ids = geometry.mappings.map(m => m[endpointField])
  assert.deepEqual([eye.positiveSourcePortId, eye.negativeSourcePortId], eye.polarity === 1 ? ids : ids.toReversed(), 'Native eye resolves actual extracted endpoint ports')
  const metrics = await readJson(join(out, 'metrics.json')), measured = independentMetrics(rows, modeling.simulation, eye)
  for (const [key, value] of Object.entries(measured)) {
    if (key === 'centerSamples') continue
    if (Array.isArray(value)) value.forEach((v, i) => close(v, metrics[key][i], `${key}[${i}]`))
    else close(value, metrics[key], key)
  }
  const folded = (await readFile(join(out, 'eye-data.csv'), 'utf8')).trim().split(/\r?\n/)
  assert.equal(folded.shift(), 'window,folded_time_s,differential_v')
  const ui = eye.unitIntervalSeconds, expectedWindows = []
  for (let start = measured.eyePhaseSeconds - ui / 2; start + 2 * ui <= rows.at(-1)[0]; start += ui)
    if (start >= eye.startTimeSeconds) expectedWindows.push(start)
  assert.equal(folded.length, expectedWindows.length * 1200, 'Every complete measured eye window included')
  for (const [i, text] of folded.entries()) {
    const [window, time, value] = text.split(',').map(Number), point = i % 1200
    assert.equal(window, Math.floor(i / 1200))
    close(time, 2 * ui * point / 1199, 'Folded time interpolation grid')
    close(value, interpolated(rows, expectedWindows[window] + time, eye.differentialColumn) * eye.polarity, 'Every eye voltage derived independently from waveform', 1e-8, 1e-9)
  }
  return { status: 'passed', outputDir: out, receiptFilesIndependentlyHashed: Object.keys(recomputed).length, sourceFilesIndependentlyHashed,
    sourceCircuitJsonSha256: hash(circuitBytes), originalBoardSha256: hash(original), boardGeometryAudit, originalPcbTracesPreserved: routedShapes(originalCircuit).length, routeAudit, vendors, commands, binaryAudit, matrixAudit,
    nativeEye: eye, foldedEyeSamplesIndependentlyChecked: folded.length, foldedEyeWindows: expectedWindows.length,
    independentlyMeasured: measured, limitations: receipt.limitations,
    conclusion: 'Reproducible execution of the declared reduced channel; no independent board, silicon, firmware or manufacturing validation is inferred.' }
}

export async function compareFreshRuns(aDir, bDir) {
  const a = await readJson(join(aDir, 'receipt.json')), b = await readJson(join(bDir, 'receipt.json'))
  assert.notEqual(resolve(aDir), resolve(bDir))
  assert.deepEqual(a.sourceFiles,b.sourceFiles,'Both fresh runs execute identical package source/config bytes')
  if(a.schemaVersion===3) assert.deepEqual(a.converter.files,b.converter.files,'Both runs use identical compiled converter bytes')
  const paths = a.schemaVersion===3
    ? Object.keys(a.files).filter(path=>/\.(?:cir|lib|csv|png|svg)$/.test(path)||/^(?:inputs\/circuit|geometry|vendor-sources|electrical-node-map|converter-runtime|circuit-results)\.json$/.test(path)||/(?:extraction|experiment|waveform|eyes|eye-data|native-ibis-assembly)\.json$/.test(path)).sort()
    : ['channel.cir', 'simulation.cir', 'driver.lib', 'receiver.lib', 'waveform.csv', 'metrics.json', 'inputs/circuit.json', 'geometry.json']
  for (const e of a.matrices) paths.push(`stage-${e.stage}/Zc.mat`, `stage-${e.stage}/refinement/Zc.mat`, `stage-${e.stage}/channel.csv`, `stage-${e.stage}/extraction.json`)
  for (const path of ['native-ibis-assembly.json','project-provenance.json','eyediagram.json', 'eye-data.csv', 'eye.png', 'eye.svg', 'waveform.png', 'waveform.svg']) if (a.files[path]&&!paths.includes(path)) paths.push(path)
  const compared = []
  for (const path of paths) {
    const ah = hash(await readFile(join(aDir, path))), bh = hash(await readFile(join(bDir, path)))
    assert.equal(ah, bh, `Fresh execution byte comparison: ${path}`)
    compared.push({ path, sha256: ah, byteIdentical: true })
  }
  return { status: 'passed', runs: [resolve(aDir), resolve(bDir)], compared }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [a, b, explicitReportPath] = process.argv.slice(2)
  if (!a || !b) throw new Error('Usage: node scripts/audit-eye.mjs RUN_A RUN_B [REPORT.json]')
  const reportPath = explicitReportPath ?? join(dirname(resolve(a)), 'independent-audit.json')
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const report = { runs: [await auditRun(a, { sourceRoot }), await auditRun(b, { sourceRoot })], repeatability: await compareFreshRuns(a, b) }
  await mkdir(dirname(resolve(reportPath)), { recursive: true })
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
  console.log(`Independent audit passed: ${resolve(reportPath)}`)
}
