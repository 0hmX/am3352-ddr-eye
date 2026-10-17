import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { assertComparable, compareRuns, comparisonIdentity, comparisonPairs, stimulusActivity, waveformDifference,
  type ComparisonInput } from '../src/comparison.js'

const fixture = (): ComparisonInput => {
  const references = { pullup: 'vdd', pulldown: 'gnd', powerClamp: 'vdd', groundClamp: 'gnd' }
  return {
    network: { geometry: 'same-network', circuit: 'same-circuit', modeling: 'same-modeling' },
    geometry: { mappings: [{ from: 'tx0', to: 'rx0' }, { from: 'tx1', to: 'rx1' }] },
    plan: { startTimeSeconds: 0, durationSeconds: 10, maxStepSeconds: .01, experiment: {},
      stimuli: ['tx0', 'tx1'].map((port, index) => ({ source_port_id: port, unit_interval_ms: 1000,
        start_time_ms: 0, initial_state: 0, pattern: { type: 'bits', bits: index ? '0' : '00101101', repeat: true } })) },
    assembly: [{ sourceSha256: 'same-vendor-model', definition: { source: { content: 'vendor' }, component: 'chip',
      pinMap: { '1': 'tx0', '2': 'tx1', '3': 'rx0', '4': 'rx1' }, corner: 'typical', packagePolicy: 'vendor' },
      spicePinMapping: { P1: 'tx0', P2: 'tx1', P3: 'rx0', P4: 'rx1' }, metadata: {
        converterVersion: '0.0.2', sourceSha256: 'same-vendor-model', packagePolicy: 'vendor',
        tableExtrapolation: 'hold-endpoint-current', omissions: [], packageData: { mappedPins: [] }, differentialPins: [],
        pins: ['tx0', 'tx1', 'rx0', 'rx1'].map((port, i) => ({ physicalPin: String(i + 1), port, model: 'BUFFER',
          selector: 'BUFFER', selectorChoices: ['BUFFER'], modelType: i < 2 ? 'Output' : 'Input',
          polarity: 'non-inverting', polarityDeclared: true, references,
          runState: i < 2 ? { mode: 'output', enabled: true } : { mode: 'input' } })),
      } }],
    probe: { name: 'DQ_RX', simulationVoltageProbeId: 'probe', signalSourceId: 'rx0', referenceSourceId: 'gnd', referenceNode: '0', column: 1 },
    eye: { simulationVoltageProbeId: 'probe', unitIntervalSeconds: 1, timeOriginSeconds: 0,
      startTimeSeconds: 2, endTimeSeconds: 10, directory: 'eyes/eye', sourceSha256: 'waveform-hash' },
  }
}

test('comparison permits only selected neighbor traffic changes', () => {
  const quiet = fixture(), active = structuredClone(quiet)
  active.plan.stimuli[1].pattern.bits = '01'
  active.assembly[0].metadata.pins[1].stimulusHash = 'different-neighbor-schedule'
  assert.doesNotThrow(() => assertComparable([comparisonIdentity(quiet), comparisonIdentity(active)]))
  for (const mutate of [
    (input: ComparisonInput) => { input.network.geometry = 'different-route' },
    (input: ComparisonInput) => { input.plan.stimuli[0].pattern.bits = '0101' },
    (input: ComparisonInput) => { input.plan.maxStepSeconds *= 2 },
    (input: ComparisonInput) => { input.plan.experiment.spice_options = { method: 'trap' } },
    (input: ComparisonInput) => { input.plan.experiment.spice_options = { reltol: 1e-3 } },
    (input: ComparisonInput) => { input.plan.experiment.spice_options = { vntol: 1e-4 } },
    (input: ComparisonInput) => { input.eye.timeOriginSeconds = .5 },
    (input: ComparisonInput) => { input.probe.referenceSourceId = 'different-reference' },
    (input: ComparisonInput) => { input.assembly[0].sourceSha256 = 'different-vendor-bytes' },
    (input: ComparisonInput) => { input.assembly[0].definition.corner = 'minimum' },
    (input: ComparisonInput) => { input.assembly[0].metadata.pins[1].references.pullup = 'different-rail' },
  ]) {
    const changed = structuredClone(active); mutate(changed)
    assert.throws(() => assertComparable([comparisonIdentity(quiet), comparisonIdentity(changed)]), /comparison_fairness/)
  }
  active.plan.experiment.spice_options = { method: 'gear', abstol: 1e-12, reltol: 1e-5 }
  assert.doesNotThrow(() => assertComparable([comparisonIdentity(quiet), comparisonIdentity(active)]))
  active.assembly[0].metadata.pins[1].runState = { mode: 'output', enabled: false }
  assert.throws(() => comparisonIdentity(active), /comparison_binding/)
  assert.throws(() => assertComparable([]), /comparison_empty/)
  const differential = fixture()
  differential.probe.referenceSourceId = 'rx1'
  differential.probe.referenceNode = 'neighbor-node'
  assert.throws(() => comparisonIdentity(differential), /ground-referenced/)
  differential.probe.referenceSourceId = 'aliased-reference-net'
  assert.throws(() => comparisonIdentity(differential), /ground-referenced/)
})

test('quiet includes startup and pairing follows declared activity, not ordering or names', () => {
  const quiet = fixture().plan.stimuli[1], switching = { ...quiet, pattern: { ...quiet.pattern, bits: '01' } }
  const neighbor = (stimulus: typeof quiet) => ({ from: 'tx1', to: 'rx1',
    wholeRun: stimulusActivity(stimulus, 0, 10), gate: stimulusActivity(stimulus, 2, 10) })
  const runs = [{ label: 'arbitrary active name', neighbors: [neighbor(switching)] },
    { label: 'arbitrary quiet name', neighbors: [neighbor(quiet)] }]
  assert.deepEqual(comparisonPairs(runs), [{ quietIndex: 1, activeIndex: 0, quiet: 'arbitrary quiet name', active: 'arbitrary active name' }])
  const startup = { ...quiet, pattern: { ...quiet.pattern, bits: '1' } }
  assert.equal(neighbor(startup).wholeRun.behavior, 'switching')
  assert.equal(neighbor(startup).gate.behavior, 'constant')
  assert.throws(() => comparisonPairs([runs[1], { label: 'startup-only', neighbors: [neighbor(startup)] }]), /measurement gate/)
  assert.throws(() => comparisonPairs([]), /comparison_case/)
  assert.throws(() => comparisonPairs([runs[0], runs[0]]), /comparison_case/)
  assert.throws(() => stimulusActivity({ ...quiet, pattern: { ...quiet.pattern, repeat: false } }, 2, 10), /cover/)
})

test('waveform difference integrates a triangle exactly across different adaptive time axes', () => {
  const result = waveformDifference({ quiet: [[0, 0], [.6, 0], [2, 0]], active: [[0, 0], [1, 1], [2, 0]],
    quietColumn: 1, activeColumn: 1, startSeconds: .5, endSeconds: 1.5 })
  assert.equal(result.peakAbsoluteV, 1)
  assert.equal(result.peakTimeSeconds, 1)
  assert.equal(result.minimumV, .5)
  assert.ok(Math.abs(result.timeRmsV - Math.sqrt(7 / 12)) < 1e-12)
  const same = waveformDifference({ quiet: [[0, 0], [.3, .3], [1, 1]], active: [[0, 0], [.7, .7], [1, 1]],
    quietColumn: 1, activeColumn: 1, startSeconds: 0, endSeconds: 1 })
  assert.ok(same.peakAbsoluteV < 1e-15)
})

test('difference rejects empty, nonfinite, nonmonotonic and extrapolated samples', () => {
  const base = { quiet: [[0, 0], [1, 1]], active: [[0, 0], [1, 1]], quietColumn: 1, activeColumn: 1, startSeconds: 0, endSeconds: 1 }
  for (const change of [{ quiet: [] }, { active: [[0, 0], [0, 1]] }, { active: [[0, 0], [1, NaN]] },
    { quietColumn: 0 }, { activeColumn: 4 }, { startSeconds: -.1 }, { endSeconds: 1.1 },
    { startSeconds: 1 }, { endSeconds: Infinity }, { startSeconds: NaN }])
    assert.throws(() => waveformDifference({ ...base, ...change }), /comparison_waveform|comparison_gate/)
})

test('saved-run comparison binds artifacts and computes pairs before shared rendering', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pcb-comparison-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const hash = (data: string) => createHash('sha256').update(data).digest('hex')
  const files: Record<string, string> = {}
  const save = async (relative: string, value: unknown) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    await mkdir(dirname(join(directory, relative)), { recursive: true })
    await writeFile(join(directory, relative), text); files[relative] = hash(text)
  }
  for (const path of ['inputs/circuit.json', 'inputs/modeling.json', 'electrical-node-map.json', 'converter-runtime.json']) await save(path, {})
  await save('channel.cir', '* synthetic test network\n')
  const input = fixture()
  await save('geometry.json', input.geometry)
  const binarySha256 = { fasthenry: 'henry', fastercap: 'cap', ngspice: 'spice' }
  await save('tool-build-receipt.json', { unmodifiedSources: true, binarySha256 })
  await save('tool-evidence.json', Object.fromEntries(Object.entries(binarySha256).map(([name, sha256]) => [name, { sha256 }])))
  const experiments = []
  for (const [name, bits, values] of [['quiet', '0', '0'], ['switching', '01', '.2']]) {
    const folder = `experiments/${name}`, waveform = `time_s,probe_v\n0,${values}\n5,${values}\n10,${values}\n`
    const plan = structuredClone(input.plan); plan.stimuli[1].pattern.bits = bits
    const eye = { ...input.eye, sourceSha256: hash(waveform) }
    await save(`${folder}/waveform.csv`, waveform)
    await save(`${folder}/experiment.json`, plan)
    await save(`${folder}/assembly.json`, input.assembly)
    await save(`${folder}/${eye.directory}/eye-data.csv`, 'window,folded_time_s,time_s,voltage_v\n0,0,2,0\n')
    experiments.push({ name, directory: folder, assembly: `${folder}/assembly.json`, probes: [input.probe], eyes: [eye] })
  }
  await writeFile(join(directory, 'receipt.json'), JSON.stringify({ status: 'executed', files, experiments }))
  // This executable stubs only drawing; comparison still reads and verifies every input.
  const renderer = join(directory, 'renderer')
  await writeFile(renderer, `#!${process.execPath}\nprocess.exit(0)\n`, { mode: 0o755 })
  const outputDir = join(directory, 'new-parent', 'comparison')
  const result = await compareRuns({ directories: [directory], outputDir, probeName: 'DQ_RX', python: renderer })
  assert.equal(result.changes.length, 1)
  assert.equal(result.changes[0].peakAbsoluteV, .2)
  assert.ok(Math.abs(result.changes[0].timeRmsV - .2) < 1e-12)
  const manifest = JSON.parse(await readFile(result.manifest, 'utf8'))
  assert.equal(manifest.series[0].waveformSha256, files['experiments/quiet/waveform.csv'])
  await assert.rejects(compareRuns({ directories: [directory], outputDir, probeName: 'DQ_RX', python: renderer }), /EEXIST/)
  await writeFile(join(directory, 'experiments/quiet/waveform.csv'), 'changed after receipt')
  await assert.rejects(compareRuns({ directories: [directory], outputDir: join(directory, 'rejected'), probeName: 'DQ_RX', python: renderer }), /comparison_provenance/)
})
