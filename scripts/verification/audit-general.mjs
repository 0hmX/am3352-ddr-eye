import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { hostname, platform, arch } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { sha256, json, close, inventory, parseCsv, strictTimes, interpolate, completeWindows, boardGeometry, bitSchedule } from './independent-helpers.mjs'
import { auditMatrices } from './audit-matrices.mjs'
import { auditIbis } from './audit-ibis.mjs'
import { auditStartup } from './audit-startup.mjs'

function unique(elements, key, label) {
  const ids = elements.map(element => element[key])
  assert.ok(ids.every(id => typeof id === 'string' && id.length), `${label}: all IDs present`)
  assert.equal(new Set(ids).size, ids.length, `${label}: unique IDs`)
}
function exactlyOne(elements, predicate, label) {
  const matches = elements.filter(predicate)
  assert.equal(matches.length, 1, `${label}: exactly one match`)
  return matches[0]
}

// Compare saved copper without importing the geometry generator. Ring order and
// winding may change during normalization; every physical vertex must survive.
export function auditGroundCopper(circuit, modeling, geometry) {
  const reference = selector => exactlyOne(circuit, record => record.type === 'source_port' && (selector.sourcePortId
    ? record.source_port_id === selector.sourcePortId
    : record.source_component_id === exactlyOne(circuit, component => component.type === 'source_component' && component.name === selector.component, 'Reference component').source_component_id &&
      (record.name === selector.port || record.port_hints?.includes(selector.port) || `pin${record.pin_number}` === selector.port)), 'Physical ground reference').source_port_id
  const connected = new Set([reference(modeling.channelReference)])
  const traces = circuit.filter(record => record.type === 'source_trace')
  for (let previous = -1; previous !== connected.size;) {
    previous = connected.size
    for (const trace of traces) {
      const members = [...trace.connected_source_port_ids, ...(trace.connected_source_net_ids ?? [])]
      if (members.some(id => connected.has(id))) members.forEach(id => connected.add(id))
    }
  }
  const ground = exactlyOne(circuit, record => record.type === 'source_net' && record.is_ground && connected.has(record.source_net_id), 'Net-inferred ground')
  const pours = circuit.filter(record => record.type === 'pcb_copper_pour' && connected.has(record.source_net_id))
  assert.ok(pours.length > 0, 'Physical copper on the inferred ground net')
  const ring = points => {
    const tokens = points.map(point => point.map(value => { assert.ok(Number.isFinite(value)); return value.toPrecision(15) }).join(','))
    const rotations = values => values.map((_, i) => [...values.slice(i), ...values.slice(0, i)].join(';'))
    return [...rotations(tokens), ...rotations([...tokens].reverse())].sort()[0]
  }
  const polygon = rings => [ring(rings[0]), ...rings.slice(1).map(ring).sort()]
  return geometry.cells.map(cell => {
    const copper = cell.routedCopper
    assert.ok(copper, 'Routed reduction retains actual ground geometry')
    assert.equal(copper.sourceNetId, ground.source_net_id, 'Extracted plane belongs to independently inferred GND net')
    assert.equal(copper.referenceSourcePortIds.length, 2, 'Two physical reference contacts')
    assert.notEqual(copper.referenceSourcePortIds[0], copper.referenceSourcePortIds[1], 'Distinct driver and receiver ground contacts')
    assert.equal(copper.referenceSourcePortIds[0], reference(modeling.channelReference))
    if (modeling.groundReturn) assert.equal(copper.referenceSourcePortIds[1], reference(modeling.groundReturn))
    copper.referenceSourcePortIds.forEach(id => {
      assert.ok(connected.has(id), 'Both reference contacts connect electrically to GND')
      reference({ sourcePortId: id })
    })
    assert.deepEqual(copper.pours.map(pour => pour.pcbCopperPourId).sort(), pours.map(pour => pour.pcb_copper_pour_id).sort(), 'Every net-connected ground pour included')
    for (const pour of copper.pours) {
      const original = exactlyOne(pours, record => record.pcb_copper_pour_id === pour.pcbCopperPourId, 'Original ground pour')
      assert.equal(original.shape, 'brep', 'Ground pour has real polygon geometry')
      assert.equal(pour.layer, original.layer, 'Ground layer preserved')
      const originalRings = [original.brep_shape.outer_ring, ...original.brep_shape.inner_rings].map(ring => ring.vertices.map(point => [point.x, point.y]))
      assert.deepEqual(polygon(pour.polygon), polygon(originalRings), 'Ground boundaries and every cutout preserved')
      const layer = exactlyOne(modeling.stackup, layer => layer.name === pour.layer, 'Ground stackup layer')
      close(pour.zMinMm, layer.zMinMm, 'Ground copper bottom from stackup')
      close(pour.zMaxMm, layer.zMaxMm, 'Ground copper top from stackup')
    }
    return { stage: cell.stage, sourceNetId: ground.source_net_id, referenceSourcePortIds: copper.referenceSourcePortIds, groundPourIds: copper.pours.map(pour => pour.pcbCopperPourId), boundariesAndCutoutsPreserved: true }
  })
}

export async function auditRun(projectRoot, directory, { verifyLiveSources = true } = {}) {
  const root = resolve(projectRoot), out = resolve(directory)
  const receipt = await json(join(out, 'receipt.json'))
  assert.equal(receipt.status, 'executed')
  assert.ok(receipt.schemaVersion >= 3, 'General experiment receipt, not legacy clock-only receipt')
  assert.equal(receipt.execution.solverResultCache, false, 'No cached solver results')
  assert.equal(receipt.execution.host, hostname())
  assert.equal(receipt.execution.platform, platform())
  assert.equal(receipt.execution.architecture, arch())
  const hashes = await inventory(out)
  delete hashes['receipt.json']
  assert.deepEqual(hashes, receipt.files, 'Exact generated artifact inventory and hashes')

  const sources = []
  const packageRoot = receipt.sourceRoot ?? join(root, 'node_modules/pcb-spice-pipeline')
  for (const [path, expected] of Object.entries(receipt.sourceFiles ?? {})) {
    if (verifyLiveSources) {
      assert.equal(sha256(await readFile(join(packageRoot, path))), expected, `Executed package source ${path}`)
      sources.push(path)
    }
  }
  assert.ok(Object.keys(receipt.sourceFiles ?? {}).length > 0, 'Executed reusable package source fingerprints are recorded')
  const projectInputs = []
  for (const [path, entry] of Object.entries(receipt.project?.files ?? {})) {
    assert.equal(sha256(await readFile(join(out, 'inputs/project', path))), entry.sha256, `Captured actual project input ${path}`)
    if (verifyLiveSources) assert.equal(sha256(await readFile(join(root, path))), entry.sha256, `Project input ${path}`)
    projectInputs.push(path)
  }
  assert.ok(projectInputs.length > 0, 'Real TSX project input fingerprints')
  if (verifyLiveSources) for (const [path, expected] of Object.entries(receipt.project?.dependencyFiles ?? {}))
    assert.equal(sha256(await readFile(path)), expected, `Executed dependency ${path}`)
  let converterFilesIndependentlyHashed = 0
  assert.ok(receipt.converter?.sourceRoot && receipt.converter.files, 'Complete converter runtime fingerprint manifest')
  assert.deepEqual(await json(join(out, 'converter-runtime.json')), receipt.converter, 'Converter runtime manifest matches root receipt')
  if (verifyLiveSources) for (const [path, expected] of Object.entries(receipt.converter.files)) {
    assert.equal(sha256(await readFile(join(receipt.converter.sourceRoot, path))), expected, `Executed converter runtime file ${path}`)
    converterFilesIndependentlyHashed++
  }

  const inputBytes = await readFile(join(out, 'inputs/circuit.json'))
  const circuit = JSON.parse(inputBytes)
  assert.equal(sha256(inputBytes), receipt.sourceCircuitJsonSha256, 'Canonical executed circuit input hash')
  const results = await json(join(out, 'circuit-results.json'))
  assert.ok(Array.isArray(results), 'Canonical Circuit JSON results array')
  const eyes = circuit.filter(element => element.type === 'simulation_eye_diagram')
  const probes = circuit.filter(element => element.type === 'simulation_voltage_probe')
  const experiments = circuit.filter(element => element.type === 'simulation_experiment')
  unique(eyes, 'simulation_eye_diagram_id', 'Eyes')
  unique(probes, 'simulation_voltage_probe_id', 'Probes')
  unique(experiments, 'simulation_experiment_id', 'Experiments')
  assert.ok(eyes.length && experiments.length, 'Native eye and experiment declarations serialized')
  const graphs = results.filter(element => element.type === 'simulation_transient_voltage_graph')
  unique(graphs, 'simulation_transient_voltage_graph_id', 'Waveform results')
  const { parseRecord } = await import(pathToFileURL(join(projectRoot,'packages/pcb-spice-pipeline/dist/schema.js')).href)
  const serializedTypes = new Set(['simulation_experiment', 'simulation_voltage_probe', 'simulation_eye_diagram', 'simulation_digital_stimulus', 'simulation_ibis_model', 'simulation_ibis_pin_state', 'simulation_transient_voltage_graph'])
  let schemaRoundTrips = 0
  for (const record of [...circuit, ...graphs].filter(record => serializedTypes.has(record.type))) {
    const roundTrip = parseRecord(JSON.parse(JSON.stringify(record)))
    assert.deepEqual(JSON.parse(JSON.stringify(roundTrip)), record, `Registered Circuit JSON roundtrip preserves ${record.type} fields and IDs`)
    schemaRoundTrips++
  }

  const modeling = await json(join(out, 'inputs/modeling.json'))
  const geometry = await json(join(out, 'geometry.json'))
  const nodeMap = await json(join(out, 'electrical-node-map.json'))
  assert.equal(geometry.units.circuitJson, 'mm', 'Circuit JSON length units')
  assert.ok(['straightened-stages', 'routed-copper'].includes(modeling.reduction), 'Supported channel geometry is explicitly chosen')
  assert.ok(modeling.stackup.length > 0 && modeling.extraction, 'Locked board construction and extraction inputs')
  if (modeling.reduction === 'straightened-stages') assert.ok(modeling.profiles, 'Straightened reduction declares finite return profiles')
  assert.ok(geometry.cells.every(cell => Boolean(cell.routedCopper) === (modeling.reduction === 'routed-copper')), 'Every extracted cell agrees with the declared reduction')
  const groundCopperAudit = modeling.reduction === 'routed-copper' ? auditGroundCopper(circuit, modeling, geometry) : null
  assert.ok(circuit.some(element => element.type === 'pcb_board'), 'Actual TSX board was rendered')
  assert.ok(circuit.some(element => element.type === 'pcb_trace'), 'Actual routed copper is present')
  assert.ok([1, 2, 3].includes(geometry.mappings.length), 'Declared backend supports one to three lanes')
  for (const mapping of geometry.mappings) {
    assert.notEqual(mapping.from, mapping.to, 'Distinct physical transmitter and receiver contacts')
    assert.notEqual(nodeMap.nodes[mapping.from], nodeMap.nodes[mapping.to], 'Extracted route is not bypassed by an ideal endpoint short')
    const trace = exactlyOne(circuit, element => element.type === 'pcb_trace' && element.pcb_trace_id === mapping.pcbTraceId, 'Extracted real PCB route')
    const ports = mapping.pcbPorts.map(id => exactlyOne(circuit, element => element.type === 'pcb_port' && element.pcb_port_id === id, 'Physical route endpoint'))
    assert.equal(new Set(ports.map(port => port.source_port_id)).size, 2)
    assert.ok(mapping.originalRoute.length >= 2 && trace.route.length >= 2)
    assert.ok(mapping.stages.every(stage => stage.lengthMm > 0 && stage.widthMm > 0 && stage.thicknessMm > 0), 'Positive actual routed stage dimensions')
  }
  let preservedBoardGeometry = null
  if (modeling.fixtureProvenance?.originalJsonSha256 && modeling.circuit) {
    const originalBytes = await readFile(join(root, dirname(receipt.project.entry), modeling.circuit))
    assert.equal(sha256(originalBytes), modeling.fixtureProvenance.originalJsonSha256, 'Original routed board bytes')
    preservedBoardGeometry = boardGeometry(JSON.parse(originalBytes), circuit)
  }
  const independentlyRecomputedMatrices = []
  for (const cell of geometry.cells) independentlyRecomputedMatrices.push(await auditMatrices(out, cell, modeling))

  const commands = []
  for (const path of Object.keys(hashes).filter(path => path.endsWith('.command.json'))) {
    const command = await json(join(out, path))
    assert.equal(command.exitCode, 0, `Fresh solver exited successfully: ${path}`)
    assert.equal(resolve(command.cwd), dirname(join(out, path)), 'Solver command working directory matches evidence location')
    commands.push({ path, ...command })
  }
  for (const name of ['fasthenry', 'fastercap', 'ngspice']) {
    const tool = receipt.toolEvidence[name]
    assert.ok(tool, `Native ${name} binary evidence`)
    assert.equal(tool.host, receipt.execution.host)
    assert.equal(tool.platform, receipt.execution.platform)
    assert.equal(sha256(await readFile(tool.executable)), tool.sha256, `Executed ${name} binary bytes`)
  }

  const studies = []
  for (const run of receipt.experiments) {
    const declared = exactlyOne(experiments, element => element.simulation_experiment_id === run.simulationExperimentId, 'Referenced experiment')
    close(declared.end_time_ms / 1000, run.durationSeconds, 'Experiment duration milliseconds -> seconds')
    close(declared.start_time_ms / 1000, run.startTimeSeconds, 'Experiment recording gate milliseconds -> seconds')
    close(declared.time_per_step / 1000, run.maxStepSeconds, 'Experiment maximum step milliseconds -> seconds')
    assert.equal(run.solverInvocations, 1, 'All experiment eyes share one transient solve')
    const experimentDir = join(out, run.directory)
    const deck = await readFile(join(experimentDir, 'simulation.cir'), 'utf8')
    const subcircuits = [...deck.matchAll(/^\s*\.subckt\s+(\S+)/gmi)].map(match => match[1].toLowerCase())
    assert.equal(new Set(subcircuits).size, subcircuits.length, 'No conflicting duplicate subcircuit definitions')
    const channelNodes = geometry.mappings.map(mapping => nodeMap.nodes[mapping.from]).concat(geometry.mappings.map(mapping => nodeMap.nodes[mapping.to]), '0')
    assert.ok(deck.split('\n').includes(`XCHAN ${channelNodes.join(' ')} CHANNEL`), 'Executed extracted channel uses the declared physical endpoint nodes')
    const physicalSupplies = []
    for (const [i, source] of circuit.filter(element => element.type === 'simulation_voltage_source').entries()) {
      if (source.wave_shape) continue
      const line = deck.split('\n').find(line => line.startsWith(`VPHYSICAL${i} `))
      assert.ok(line, 'Declared physical DC supply is present in actual deck')
      const [, positive, negative, voltage] = line.split(/\s+/)
      assert.equal(positive, nodeMap.nodes[source.terminal1_source_port_id])
      assert.equal(negative, nodeMap.nodes[source.terminal2_source_port_id])
      close(Number(voltage), source.voltage, 'Actual supply magnitude equals native TSX declaration')
      physicalSupplies.push({ source: source.simulation_voltage_source_id, positiveSourcePortId: source.terminal1_source_port_id, negativeSourcePortId: source.terminal2_source_port_id, positiveNode: positive, negativeNode: negative, voltageV: Number(voltage) })
    }
    const transients = [...deck.matchAll(/^\s*(?:\.tran|tran)\s+(\S+)\s+(\S+)([^\r\n]*)$/gm)]
    assert.equal(transients.length, 1, 'One actual transient directive per experiment')
    close(Number(transients[0][1]), run.maxStepSeconds, 'Executed transient step')
    close(Number(transients[0][2]), run.durationSeconds, 'Executed transient stop')
    const actualSolverCommands = commands.filter(command => command.path === `${run.directory}/ngspice.command.json`)
    assert.equal(actualSolverCommands.length, 1, 'One recorded ngspice invocation per experiment')
    assert.ok(actualSolverCommands[0].args.includes('simulation.cir'))
    const csv = parseCsv(await readFile(join(experimentDir, 'waveform.csv'), 'utf8'))
    assert.equal(csv.headers[0], 'time_s')
    const rawLines = (await readFile(join(experimentDir, 'waveform.dat'), 'utf8')).trim().split(/\r?\n/)
    rawLines.shift()
    const rawRows = rawLines.map(line => line.trim().split(/\s+/).map(Number))
    assert.equal(rawRows.length, csv.rows.length, 'CSV retains every actual ngspice data row')
    for (let i = 0; i < rawRows.length; i++) {
      assert.equal(rawRows[i].length, csv.rows[i].length, 'Actual solver column count')
      rawRows[i].forEach((value, column) => close(csv.rows[i][column], value, 'CSV value independently compared with raw ngspice output', 1e-12, 1e-18))
    }
    const times = csv.rows.map(row => row[0])
    strictTimes(times, 'Executed waveform')
    close(times.at(-1), run.durationSeconds, 'Solver reached requested duration', 1e-8, 1e-15)
    const probeValues = new Map()
    const vendorIbis = await auditIbis(out, experimentDir, circuit, run)
    const physicalSanity = await auditStartup({ out, circuit, run, vendorIbis, nodeMap, csv })
    for (const probe of run.probes) {
      const declaredProbe = exactlyOne(probes, element => element.simulation_voltage_probe_id === probe.simulationVoltageProbeId, 'Referenced voltage probe')
      const index = csv.headers.indexOf(`${probe.simulationVoltageProbeId}_v`)
      assert.ok(index > 0, 'Waveform column identified by canonical probe ID')
      assert.equal(index, probe.column, 'Receipt column maps recorded probe')
      assert.notEqual(probe.signalNode, probe.referenceNode, 'Probe observes two distinct electrical nodes')
      assert.equal(probe.signalNode, nodeMap.nodes[probe.signalSourceId], 'Actual signal observation node')
      assert.equal(probe.referenceNode, probe.referenceSourceId ? nodeMap.nodes[probe.referenceSourceId] : '0', 'Actual reference observation node')
      const referenceExpression = probe.referenceNode === '0' ? '0' : `v(${probe.referenceNode})`
      assert.ok(deck.split('\n').includes(`let probe${index - 1} = v(${probe.signalNode})-${referenceExpression}`), 'Actual ngspice observed the declared voltage difference')
      assert.equal(declaredProbe.signal_input_source_port_id ?? declaredProbe.signal_input_source_net_id, probe.signalSourceId)
      assert.equal(declaredProbe.reference_input_source_port_id ?? declaredProbe.reference_input_source_net_id, probe.referenceSourceId)
      const graph = exactlyOne(graphs, element => element.simulation_experiment_id === run.simulationExperimentId && element.simulation_voltage_probe_id === probe.simulationVoltageProbeId, 'Result bound to experiment and probe IDs')
      assert.equal(graph.timestamps_ms.length, times.length)
      assert.equal(graph.voltage_levels.length, times.length)
      const values = csv.rows.map(row => row[index])
      const [minimumV, maximumV] = values.reduce(([minimum, maximum], value) => [Math.min(minimum, value), Math.max(maximum, value)], [Infinity, -Infinity])
      const observedLanes = geometry.mappings.filter(lane => [lane.from, lane.to].some(port => port === probe.signalSourceId || port === probe.referenceSourceId))
      const switching = circuit.filter(element => element.type === 'simulation_digital_stimulus' && element.simulation_experiment_id === run.simulationExperimentId)
        .some(stimulus => observedLanes.some(lane => [lane.from, lane.to].includes(stimulus.source_port_id)) &&
          bitSchedule(stimulus, run.durationSeconds * 1000).transitions.length > 0)
      if (switching) assert.ok(maximumV - minimumV > 0.5, 'Declared active data/clock produces a voltage swing, not a flat placeholder')
      const signalEndpoints = new Set(geometry.mappings.flatMap(mapping => [mapping.from, mapping.to]))
      const differential = signalEndpoints.has(probe.signalSourceId) && signalEndpoints.has(probe.referenceSourceId)
      if (differential && switching) assert.ok(minimumV < -0.2 && maximumV > 0.2, 'Complementary differential signals execute both voltage polarities')
      // A single-ended RS-485 bus leg has a nonzero common-mode voltage;
      // recording a leg relative to GND does not make it a CMOS logic pad.
      const isCmosFixture = geometry.mappings.length === 1 && circuit.some(element => element.type === 'simulation_ibis_model' && element.ibis_component_name === 'LVC1G04_DCK')
      if (!differential && isCmosFixture) assert.ok(minimumV < 0.5 && maximumV > 2.5, 'This declared 3.3-V CMOS fixture executes both pad states')
      for (let i = 0; i < times.length; i++) {
        close(graph.timestamps_ms[i] / 1000, times[i], 'Graph time is actual solver time', 1e-8, 1e-18)
        close(graph.voltage_levels[i], values[i], 'Graph voltage is actual recorded probe voltage', 1e-8, 1e-9)
      }
      probeValues.set(probe.simulationVoltageProbeId, { graph, values, declaredProbe, observedVoltageRangeV: [minimumV, maximumV], differential })
    }
    const checkedEyes = []
    for (const eye of run.eyes) {
      const declaredEye = exactlyOne(eyes, element => element.simulation_eye_diagram_id === eye.simulationEyeDiagramId, 'Referenced eye declaration')
      assert.equal(declaredEye.simulation_experiment_id, run.simulationExperimentId)
      assert.equal(declaredEye.simulation_voltage_probe_id, eye.simulationVoltageProbeId)
      close(declaredEye.unit_interval_ms / 1000, eye.unitIntervalSeconds, 'Eye unit interval normalization')
      close(declaredEye.time_origin_ms / 1000, eye.timeOriginSeconds, 'Fixed declared origin is preserved')
      if (declaredEye.start_time_ms !== undefined) close(declaredEye.start_time_ms / 1000, eye.startTimeSeconds, 'Eye gate start normalization')
      if (declaredEye.end_time_ms !== undefined) close(declaredEye.end_time_ms / 1000, eye.endTimeSeconds, 'Eye gate end normalization')
      const probe = probeValues.get(eye.simulationVoltageProbeId)
      assert.ok(probe, 'Eye uses a recorded probe from this experiment')
      const windows = completeWindows({ unitInterval: eye.unitIntervalSeconds, timeOrigin: eye.timeOriginSeconds, startTime: eye.startTimeSeconds, endTime: eye.endTimeSeconds, timestamps: times })
      assert.equal(eye.windows, windows.length)
      assert.equal(eye.windowOriginsSeconds.length, windows.length)
      eye.windowOriginsSeconds.forEach((time, i) => close(time, windows[i].start, 'Window derives from declared origin, not measured transition'))
      const folded = parseCsv(await readFile(join(experimentDir, eye.directory, 'eye-data.csv'), 'utf8'))
      assert.deepEqual(folded.headers, ['window', 'folded_time_s', 'time_s', 'voltage_v'])
      assert.ok(Number.isInteger(eye.pointsPerWindow) && eye.pointsPerWindow >= 2)
      assert.equal(folded.rows.length, windows.length * eye.pointsPerWindow)
      for (let i = 0; i < folded.rows.length; i++) {
        const [window, local, absolute, voltage] = folded.rows[i]
        const expectedWindow = Math.floor(i / eye.pointsPerWindow)
        assert.equal(window, expectedWindow, 'Stable folded window index')
        const expectedLocal = 2 * eye.unitIntervalSeconds * (i % eye.pointsPerWindow) / (eye.pointsPerWindow - 1)
        close(local, expectedLocal, 'Independent folded time grid')
        close(absolute, windows[window].start + expectedLocal, 'Folded samples retain their absolute solver times')
        close(voltage, interpolate(times, probe.values, absolute), 'Independent raw-waveform interpolation', 1e-8, 1e-9)
      }
      checkedEyes.push({ id: eye.simulationEyeDiagramId, name: eye.name, probeId: eye.simulationVoltageProbeId, windows: windows.length, independentSamples: folded.rows.length, timeOriginSeconds: eye.timeOriginSeconds })
    }
    studies.push({ id: run.simulationExperimentId, name: run.name, samples: times.length, probes: run.probes.map(probe => ({ ...probe, observedVoltageRangeV: probeValues.get(probe.simulationVoltageProbeId).observedVoltageRangeV, differential: probeValues.get(probe.simulationVoltageProbeId).differential })), eyes: checkedEyes, solverInvocations: actualSolverCommands.length, physicalSupplies, vendorIbis, physicalSanity })
  }
  assert.equal(studies.reduce((count, run) => count + run.eyes.length, 0), eyes.length, 'Every native eye executed')
  return { status: verifyLiveSources ? 'passed' : 'preflight-passed', liveSourceAndDependencyVerification: verifyLiveSources, directory: out, generatedFilesIndependentlyHashed: Object.keys(hashes).length, packageSourcesIndependentlyHashed: sources.length, converterRuntimeFilesIndependentlyHashed: converterFilesIndependentlyHashed, projectInputsIndependentlyHashed: projectInputs.length, registeredSchemaRoundTripsChecked: schemaRoundTrips, preservedBoardGeometry, groundCopperAudit, independentlyRecomputedMatrices, studies, commands, limitations: receipt.limitations, conclusion: verifyLiveSources ? 'Declared experiments were executed reproducibly and folded from actual voltage observations. This does not independently validate the reduced electrical model or board signal integrity.' : 'Preflight checks executed numerical artifacts and captured inputs only; current source/dependency identity is not accepted until a fresh frozen-source run.' }
}

export async function compareRuns(a, b) {
  assert.notEqual(resolve(a), resolve(b))
  const left = await json(join(a, 'receipt.json')), right = await json(join(b, 'receipt.json'))
  assert.equal(left.execution.solverResultCache, false)
  assert.equal(right.execution.solverResultCache, false)
  const paths = Object.keys(left.files).filter(path => /\.(?:cir|lib|csv|png|svg|mat)$/.test(path) || /(?:circuit-results|geometry|extraction|eye-data)\.json$/.test(path) || path === 'inputs/circuit.json')
  assert.ok(paths.some(path => path.endsWith('refinement/Zc.mat')), 'Fresh refined field-solver comparison included')
  const compared = []
  for (const path of paths) {
    assert.ok(Object.hasOwn(right.files, path), 'Matching repeated run output inventory')
    const digest = sha256(await readFile(join(a, path)))
    assert.equal(sha256(await readFile(join(b, path))), digest, `Fresh byte comparison ${path}`)
    compared.push({ path, sha256: digest, byteIdentical: true })
  }
  return { status: 'passed', runs: [resolve(a), resolve(b)], compared }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [project, a, b, destination] = process.argv.slice(2)
  assert.ok(project && a && b && destination, 'Usage: node audit-general.mjs PROJECT RUN_A RUN_B REPORT.json')
  const report = { runs: [await auditRun(project, a), await auditRun(project, b)], repeatability: await compareRuns(a, b) }
  await mkdir(dirname(resolve(destination)), { recursive: true })
  await writeFile(destination, JSON.stringify(report, null, 2) + '\n')
  console.log(`Independent general API audit passed: ${resolve(destination)}`)
}
