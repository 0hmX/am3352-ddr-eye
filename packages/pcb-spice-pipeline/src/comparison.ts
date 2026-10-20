import { mkdir, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { IbisConversionMetadata, IbisModelDefinition } from '@tscircuit/ibis-to-spice'
import { json, sha256 } from './io.mjs'
import { transmittedBits } from './stimulus.js'
import { fail } from './matrices.mjs'
import { writeViewerData } from './viewer.js'
import { simulationSpiceOptions } from './general-spice.js'
import { reportContext, type ReportContext, type ReportRun, type ReportEye, type ReportTest } from './report.js'
import type { CircuitJson } from './schema.js'
import type { Geometry as ChannelGeometry, Modeling } from './geometry.js'

interface Stimulus {
  source_port_id: string
  bit_duration_ms: number
  start_time_ms: number
  initial_state: 0 | 1
  inverted?: boolean
  transmission_pattern: { transmission_type: 'bits'; bits: string | (0 | 1)[]; repeat: boolean }
}
interface Probe {
  name: string
  simulationVoltageProbeId: string
  signalSourceId: string
  referenceSourceId: string | null
  referenceNode: string
  column: number
}
interface Eye {
  simulationVoltageProbeId: string
  unitIntervalSeconds: number
  timeOriginSeconds: number
  startTimeSeconds: number
  endTimeSeconds: number
  directory: string
  sourceSha256: string
  windowOriginsSeconds?: number[]
}
interface Plan {
  durationSeconds: number
  startTimeSeconds: number
  maxStepSeconds: number
  stimuli: Stimulus[]
  experiment: { spice_options?: Record<string, unknown> }
}
interface Assembly {
  definition: IbisModelDefinition
  sourceSha256: string
  spicePinMapping: Record<string, string>
  metadata: IbisConversionMetadata
}
interface Geometry { mappings: Array<{ from: string; to: string }> }
export interface ComparisonInput {
  network: Record<string, string>
  geometry: Geometry
  plan: Plan
  assembly: Assembly[]
  probe: Probe
  eye: Eye
}
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
const traffic = ({ source_port_id, bit_duration_ms, start_time_ms, initial_state, inverted = false, transmission_pattern }: Stimulus) =>
  ({ source_port_id, bit_duration_ms, start_time_ms, initial_state, inverted, transmission_pattern: { ...transmission_pattern, bits: transmittedBits(transmission_pattern?.bits, 'comparison_traffic') } })

/** Actual declared levels in the gate; quiet cases also include their initial level. */
export function stimulusActivity(stimulus: Stimulus, startSeconds: number, endSeconds: number) {
  const { transmission_pattern, initial_state, inverted } = stimulus
  const bits = transmittedBits(transmission_pattern?.bits, 'comparison_traffic')
  const ui = stimulus.bit_duration_ms / 1000, start = stimulus.start_time_ms / 1000
  if (!Number.isFinite(ui) || ui <= 0 || !Number.isFinite(start) || start < 0 ||
      !Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds ||
      transmission_pattern.transmission_type !== 'bits' || typeof transmission_pattern.repeat !== 'boolean' || ![0, 1].includes(initial_state))
    fail('comparison_traffic', 'Finite timing and explicit binary neighbor traffic required')
  const levels = new Set<number>()
  if (startSeconds <= start) levels.add(initial_state ^ Number(inverted ?? false))
  const first = Math.max(0, Math.floor((startSeconds - start) / ui)), last = Math.ceil((endSeconds - start) / ui) - 1
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) fail('comparison_traffic', 'Gate bit indices must be safe integers')
  if (!transmission_pattern.repeat && last >= bits.length) fail('comparison_traffic', 'Neighbor traffic does not cover the gate')
  for (let offset = 0; offset < Math.min(bits.length, last - first + 1); offset++)
    levels.add(Number(bits[(first % bits.length + offset) % bits.length]) ^ Number(inverted ?? false))
  return { behavior: levels.size > 1 ? 'switching' : 'constant', levels: [...levels].sort() }
}

/** Compare the same exported network; only selected neighbors' traffic may change. */
export function comparisonIdentity({ network, geometry, plan, assembly, probe, eye }: ComparisonInput) {
  if (probe.referenceNode !== '0') fail('comparison_probe', 'Controlled neighbor comparison requires a ground-referenced victim probe')
  if (geometry.mappings.filter(lane => lane.to === probe.signalSourceId).length !== 1)
    fail('comparison_probe', 'Victim probe must observe exactly one selected channel receiver')
  const neighbors = geometry.mappings.filter(lane => lane.to !== probe.signalSourceId)
  if (!neighbors.length) fail('comparison_aggressor', 'At least one selected coupled neighbor required')
  const neighborPorts = new Set(neighbors.map(lane => lane.from))
  const pins = assembly.flatMap(model => model.metadata.pins)
  for (const lane of geometry.mappings) {
    const driver = pins.filter(pin => pin.port === lane.from), receiver = pins.filter(pin => pin.port === lane.to)
    if (driver.length !== 1 || driver[0].runState.mode !== 'output' || !driver[0].runState.enabled ||
        receiver.length !== 1 || receiver[0].runState.mode !== 'input' ||
        plan.stimuli.filter(stimulus => stimulus.source_port_id === lane.from).length !== 1)
      fail('comparison_binding', 'Each selected lane requires one enabled IBIS output, input receiver and explicit stimulus')
  }
  const models = assembly.map(({ definition, sourceSha256, spicePinMapping, metadata }) => ({
    definition, sourceSha256, spicePinMapping,
    metadata: { ...metadata, pins: metadata.pins.map(({ stimulusHash: _trafficHash, ...pin }) => pin) },
  }))
  return {
    network, models, solverOptions: simulationSpiceOptions(plan.experiment.spice_options),
    probe: { signal: probe.signalSourceId, reference: probe.referenceSourceId },
    timing: [plan.startTimeSeconds, plan.durationSeconds, plan.maxStepSeconds, eye.unitIntervalSeconds,
      eye.timeOriginSeconds, eye.startTimeSeconds, eye.endTimeSeconds],
    fixedTraffic: plan.stimuli.filter(stimulus => !neighborPorts.has(stimulus.source_port_id))
      .map(traffic).sort((a, b) => a.source_port_id.localeCompare(b.source_port_id)),
  }
}

export function assertComparable(identities: unknown[]) {
  if (identities.length < 2) fail('comparison_empty', 'At least two completed experiments required')
  if (identities.some(identity => canonical(identity) !== canonical(identities[0])))
    fail('comparison_fairness', 'Cases must have identical exported geometry/network, vendor models, buffer states, references, victim traffic and simulation/eye timing')
}

function neighborsFor({ geometry, plan, probe, eye }: ComparisonInput) {
  return geometry.mappings.filter(lane => lane.to !== probe.signalSourceId).map(lane => {
    const stimulus = plan.stimuli.find(item => item.source_port_id === lane.from)!
    return { ...lane, wholeRun: stimulusActivity(stimulus, 0, plan.durationSeconds),
      gate: stimulusActivity(stimulus, eye.startTimeSeconds, eye.endTimeSeconds) }
  })
}

export function comparisonPairs(cases: Array<{ label: string; neighbors: ReturnType<typeof neighborsFor> }>) {
  const quiet = cases.flatMap((run, i) => run.neighbors.length && run.neighbors.every(pin => pin.wholeRun.behavior === 'constant') ? [i] : [])
  if (quiet.length !== 1 || cases.length < 2) fail('comparison_case', 'One fully quiet case and at least one switching case required')
  const quietIndex = quiet[0], reference = cases[quietIndex].neighbors
  return cases.flatMap((run, activeIndex) => {
    if (activeIndex === quietIndex) return []
    if (!run.neighbors.some(pin => pin.gate.behavior === 'switching'))
      fail('comparison_case', 'Switching cases must have neighbor transitions inside the measurement gate')
    if (canonical(reference.map(({ from, to }) => ({ from, to }))) !== canonical(run.neighbors.map(({ from, to }) => ({ from, to }))))
      fail('comparison_aggressor', 'Cases must retain every selected neighbor')
    for (const [i, pin] of run.neighbors.entries())
      if (pin.wholeRun.behavior === 'constant' && canonical(pin.wholeRun.levels) !== canonical(reference[i].wholeRun.levels))
        fail('comparison_aggressor', 'Neighbors held quiet must retain their original level')
    return [{ quietIndex, activeIndex, quiet: cases[quietIndex].label, active: run.label }]
  })
}

export function waveformDifference({ quiet, active, quietColumn, activeColumn, startSeconds, endSeconds }: {
  quiet: number[][]; active: number[][]; quietColumn: number; activeColumn: number; startSeconds: number; endSeconds: number
}) {
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds)
    fail('comparison_gate', 'Difference requires a nonempty finite gate')
  for (const [rows, column] of [[quiet, quietColumn], [active, activeColumn]] as const) {
    if (!Number.isInteger(column) || column < 1 || rows.length < 2 || rows.some((row, i) =>
      !Number.isFinite(row[0]) || !Number.isFinite(row[column]) || (i > 0 && row[0] <= rows[i - 1][0])))
      fail('comparison_waveform', 'Finite recorded samples and strictly increasing timestamps required')
    if (startSeconds < rows[0][0] || endSeconds > rows.at(-1)![0])
      fail('comparison_gate', 'Difference gate must not extrapolate beyond recorded waveforms')
  }
  const times = [...new Set([startSeconds, endSeconds, ...quiet.map(row => row[0]), ...active.map(row => row[0])])]
    .filter(time => time >= startSeconds && time <= endSeconds).sort((a, b) => a - b)
  let qi = 0, ai = 0, peakAbsoluteV = 0, peakTimeSeconds = startSeconds, integral = 0
  let minimumV = Infinity, maximumV = -Infinity, previous: { time: number; value: number } | undefined
  const interpolate = (rows: number[][], column: number, i: number, time: number) =>
    rows[i][column] + (rows[i + 1][column] - rows[i][column]) * (time - rows[i][0]) / (rows[i + 1][0] - rows[i][0])
  for (const time of times) {
    while (qi < quiet.length - 2 && quiet[qi + 1][0] < time) qi++
    while (ai < active.length - 2 && active[ai + 1][0] < time) ai++
    const value = interpolate(active, activeColumn, ai, time) - interpolate(quiet, quietColumn, qi, time)
    if (Math.abs(value) > peakAbsoluteV) { peakAbsoluteV = Math.abs(value); peakTimeSeconds = time }
    if (previous) integral += (time - previous.time) * (previous.value ** 2 + previous.value * value + value ** 2) / 3
    minimumV = Math.min(minimumV, value); maximumV = Math.max(maximumV, value); previous = { time, value }
  }
  return { peakAbsoluteV, peakTimeSeconds, minimumV, maximumV, timeRmsV: Math.sqrt(integral / (endSeconds - startSeconds)), samples: times.length }
}

interface Receipt {
  status: string
  files: Record<string, string>
  experiments: Array<{ name: string; directory: string; assembly: string; probes: Probe[]; eyes: Eye[] }>
}
interface Series {
  label: string; root: string; receiptSha256: string; waveformPath: string; waveformSha256: string; eyeCsv: string
  probe: Probe; eye: Eye; identity: ReturnType<typeof comparisonIdentity>; neighbors: ReturnType<typeof neighborsFor>
}

export async function compareRuns({ directories, outputDir, probeName }: {
  directories: string[]; outputDir: string; probeName: string
}) {
  if (!directories.length || !probeName) fail('comparison_input', 'Provide a completed run directory and --probe NAME')
  const series: Series[] = [], waveforms: number[][][] = [], viewerRuns: ReportRun[] = []
  const limitations = new Set<string>()
  let context: ReportContext | undefined
  for (const directory of directories) {
    const root = resolve(directory), receiptBytes = await readFile(join(root, 'receipt.json'))
    const receipt = JSON.parse(receiptBytes.toString()) as Receipt
    if (receipt.status !== 'executed' || !receipt.experiments?.length) fail('comparison_run', 'Completed native general run required')
    const artifact = async (relative: string) => {
      if (isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) fail('comparison_provenance', 'Artifact paths must stay inside their run')
      const bytes = await readFile(join(root, relative))
      if (sha256(bytes) !== receipt.files[relative]) fail('comparison_provenance', `${relative} differs from the completed run receipt`)
      return bytes
    }
    const network: Record<string, string> = {}, recorded: Record<string, Buffer> = {}
    for (const path of ['inputs/circuit.json', 'inputs/modeling.json', 'geometry.json', 'electrical-node-map.json',
      'channel.cir', 'converter-runtime.json', 'tool-evidence.json', 'tool-build-receipt.json'])
      network[path] = sha256(recorded[path] = await artifact(path))
    const build = JSON.parse((await artifact('tool-build-receipt.json')).toString()) as {
      unmodifiedSources?: boolean; binarySha256?: Record<string, string>
    }
    const tools = JSON.parse((await artifact('tool-evidence.json')).toString()) as Record<string, { sha256: string }>
    if (build.unmodifiedSources !== true || ['fasthenry', 'fastercap', 'ngspice'].some(name =>
      !build.binarySha256?.[name] || build.binarySha256[name] !== tools[name]?.sha256))
      fail('comparison_provenance', 'Runs require unmodified solver sources and matching recorded executable hashes')
    const geometry = JSON.parse(recorded['geometry.json'].toString()) as ChannelGeometry
    for (const text of geometry.approximations) limitations.add(text)
    context ??= reportContext(JSON.parse(recorded['inputs/circuit.json'].toString()) as CircuitJson,
      geometry, JSON.parse(recorded['inputs/modeling.json'].toString()) as Modeling)
    for (const experiment of receipt.experiments) {
      const matches = experiment.probes.filter(probe => probe.name === probeName), probe = matches[0]
      if (matches.length !== 1) fail('comparison_probe', `${experiment.name}: exactly one probe named ${probeName} required`)
      const eyes = experiment.eyes.filter(eye => eye.simulationVoltageProbeId === probe.simulationVoltageProbeId), eye = eyes[0]
      if (eyes.length !== 1) fail('comparison_eye', `${experiment.name}: exactly one declared eye for the victim required`)
      const waveform = await artifact(join(experiment.directory, 'waveform.csv'))
      if (eye.sourceSha256 !== sha256(waveform)) fail('comparison_provenance', 'Eye is not bound to the recorded waveform')
      const eyeRelative = join(experiment.directory, eye.directory, 'eye-data.csv')
      const eyeCsv = await artifact(eyeRelative)
      const metadata = JSON.parse((await artifact(join(experiment.directory, eye.directory, 'eye-data.json'))).toString()) as Eye & ReportEye
      if (metadata.simulationVoltageProbeId !== probe.simulationVoltageProbeId || metadata.sourceSha256 !== sha256(waveform) ||
          !Array.isArray(metadata.windowOriginsSeconds) || metadata.windowOriginsSeconds.some(value => !Number.isFinite(value)))
        fail('comparison_provenance', 'Eye metadata must bind finite window origins to the recorded probe and waveform')
      const plan = JSON.parse((await artifact(join(experiment.directory, 'experiment.json'))).toString()) as Plan & ReportTest
      const assembly = JSON.parse((await artifact(experiment.assembly)).toString()) as Assembly[]
      const input = { network, geometry, plan, assembly, probe, eye }
      const identity = comparisonIdentity(input)
      waveforms.push(waveform.toString().trim().split(/\r?\n/).slice(1).map(line => line.split(',').map(Number)))
      viewerRuns.push({ name: experiment.name, rows: waveforms.at(-1)!, probes: [probe], test: plan,
        eyes: [{ ...metadata, name: metadata.name ?? probeName, csv: eyeCsv.toString() }] })
      series.push({ label: experiment.name, root, receiptSha256: sha256(receiptBytes), waveformPath: join(root, experiment.directory, 'waveform.csv'),
        waveformSha256: sha256(waveform), eyeCsv: join(root, eyeRelative), probe, eye: {...eye,windowOriginsSeconds:metadata.windowOriginsSeconds}, identity, neighbors: neighborsFor(input) })
    }
  }
  assertComparable(series.map(run => run.identity))
  const changes = comparisonPairs(series).map(pair => {
    const startSeconds = series[pair.activeIndex].eye.startTimeSeconds, endSeconds = series[pair.activeIndex].eye.endTimeSeconds
    return { ...pair, startSeconds, endSeconds, ...waveformDifference({ quiet: waveforms[pair.quietIndex], active: waveforms[pair.activeIndex],
      quietColumn: series[pair.quietIndex].probe.column, activeColumn: series[pair.activeIndex].probe.column, startSeconds, endSeconds }) }
  })
  const out = resolve(outputDir)
  await mkdir(dirname(out), { recursive: true })
  await mkdir(out, { recursive: false })
  const manifest = join(out, 'comparison.json')
  await json(manifest, { probeName, series, changes,
    differenceDefinition: 'Switching minus quiet piecewise-linear reconstructions on the union of recorded adaptive timestamps and exact gate endpoints. RMS is integrated over time.',
    limitations: ['Finite deterministic simulation; no BER, protocol compliance or hardware accuracy claim',
      'Differences include all coupling and shared return paths represented by the selected network; peaks do not bound unrecorded analog behavior'] })
  await writeViewerData(join(out,'results.html'), { runs: viewerRuns, context, comparisonProbeName: probeName, limitations:[
    'Finite deterministic comparison; no BER, protocol compliance or hardware accuracy claim.',
    ...limitations,
  ], changes }, 'Quiet versus switching comparison')
  return { directory: out, manifest, changes }
}
