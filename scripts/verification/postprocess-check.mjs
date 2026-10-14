import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { json, sha256, parseCsv, completeWindows, interpolate, close } from './independent-helpers.mjs'

const [positiveArgument, destinationArgument] = process.argv.slice(2)
assert.ok(positiveArgument && destinationArgument, 'Usage: node postprocess-check.mjs POSITIVE_RUN REPORT.json')
const out = resolve(positiveArgument), destination = resolve(destinationArgument)
const receipt = await json(join(out, 'receipt.json'))
const run = receipt.experiments[0], eye = run.eyes[0]
const experimentDir = join(out, run.directory)
const csv = parseCsv(await readFile(join(experimentDir, 'waveform.csv'), 'utf8'))
const times = csv.rows.map(row => row[0]), values = csv.rows.map(row => row[eye.column])
const before = Object.fromEntries(await Promise.all(['simulation.cir', 'waveform.dat', 'waveform.csv'].map(async path => [path, sha256(await readFile(join(experimentDir, path)))])))
// Candidate folding is invoked here; every produced sample is checked through
// the separate integer-bound and binary-search reference implementation.
const { foldProbeEye } = await import(pathToFileURL(join(receipt.sourceRoot, 'src/metrics.mjs')).href)
const variants = [
  ['origin-quarter-ui', { ...eye, timeOriginSeconds: eye.timeOriginSeconds + eye.unitIntervalSeconds / 4 }],
  ['later-gate', { ...eye, startTimeSeconds: eye.startTimeSeconds + 2 * eye.unitIntervalSeconds }],
]
const baseline = await readFile(join(experimentDir, eye.directory, 'eye-data.csv'))
const checks = []
for (const [name, declaration] of variants) {
  const folded = foldProbeEye(csv.rows, declaration, eye.pointsPerWindow)
  const expected = completeWindows({ unitInterval: declaration.unitIntervalSeconds, timeOrigin: declaration.timeOriginSeconds, startTime: declaration.startTimeSeconds, endTime: declaration.endTimeSeconds, timestamps: times })
  assert.equal(folded.windows, expected.length)
  assert.equal(folded.samples.length, expected.length * eye.pointsPerWindow)
  for (const [i, sample] of folded.samples.entries()) {
    const [window, local, absolute, voltage] = sample
    assert.equal(window, Math.floor(i / eye.pointsPerWindow))
    const gridTime = 2 * declaration.unitIntervalSeconds * (i % eye.pointsPerWindow) / (eye.pointsPerWindow - 1)
    close(local, gridTime, 'Variant local time grid')
    close(absolute, expected[window].start + gridTime, 'Variant uses fixed declared origin and gate')
    close(voltage, interpolate(times, values, absolute), 'Variant samples are independently reconstructed from the same raw waveform', 1e-8, 1e-9)
  }
  const bytes = Buffer.from('window,folded_time_s,time_s,voltage_v\n' + folded.samples.map(row => row.join(',')).join('\n') + '\n')
  assert.notEqual(sha256(bytes), sha256(baseline), 'Changing eye origin/gate changes actual folded data')
  if (name === 'later-gate') assert.ok(folded.windows < eye.windows, 'Later measurement gate excludes windows')
  const file = join(dirname(destination), 'postprocess', `${name}.csv`)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, bytes)
  checks.push({ name, status: 'passed', timeOriginSeconds: declaration.timeOriginSeconds, startTimeSeconds: declaration.startTimeSeconds, independentSamples: folded.samples.length, windows: folded.windows, file, sha256: sha256(bytes), noSolverRun: true })
}
for (const [path, digest] of Object.entries(before)) assert.equal(sha256(await readFile(join(experimentDir, path))), digest, 'Analysis controls leave executed deck and raw waveform unchanged')
await mkdir(dirname(destination), { recursive: true })
await writeFile(destination, JSON.stringify({ status: 'passed', positiveRun: out, experiment: run.simulationExperimentId, eye: eye.simulationEyeDiagramId, unchangedElectricalArtifacts: before, cases: checks }, null, 2) + '\n')
console.log(`Independent postprocessing checks passed: ${destination}`)
