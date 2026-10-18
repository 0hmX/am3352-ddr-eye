import assert from 'node:assert/strict'
import { readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { json } from './independent-helpers.mjs'

const [projectArgument, positiveRunArgument, destinationArgument] = process.argv.slice(2)
assert.ok(projectArgument && positiveRunArgument && destinationArgument, 'Usage: node negative-contract-check.mjs PROJECT POSITIVE_RUN REPORT.json')
const project = resolve(projectArgument), positive = resolve(positiveRunArgument), destination = resolve(destinationArgument)
const receipt = await json(join(positive, 'receipt.json'))
const original = await json(join(positive, 'inputs/circuit.json'))
const modeling = await json(join(positive, 'inputs/modeling.json'))
const { runPipeline } = await import(pathToFileURL(join(receipt.sourceRoot, 'dist/pipeline.mjs')).href)
const firstStimulus = original.find(record => record.type === 'simulation_digital_stimulus')
assert.ok(firstStimulus)
const mutations = [
  ['missing-stimulus', circuit => circuit.filter(record => record.simulation_digital_stimulus_id !== firstStimulus.simulation_digital_stimulus_id), /enabled output.*(?:explicit digital stimulus|one explicit)|missing_stimulus/i],
  ['duplicate-stimulus', circuit => [...circuit, { ...circuit.find(record => record.type === 'simulation_digital_stimulus'), simulation_digital_stimulus_id: 'simulation_digital_stimulus_independent_duplicate', name: 'INDEPENDENT_DUPLICATE' }], /multiple stimuli|duplicate/i],
  ['disabled-output-stimulus', circuit => circuit.map(record => {
    if (record.type === 'simulation_ibis_pin_state' && record.source_port_id === firstStimulus.source_port_id && record.simulation_experiment_id === firstStimulus.simulation_experiment_id)
      return { ...record, is_output: true, is_output_enabled: false }
    return record
  }), /stimulus requires an enabled|input\/disabled output cannot/i],
  ['unknown-eye-probe', circuit => circuit.map(record => record.type === 'simulation_eye_diagram' ? { ...record, simulation_voltage_probe_id: 'simulation_voltage_probe_does_not_exist' } : record), /probeRef.*exactly one|probe.*missing|probe.*exactly one/i],
  ['missing-fixed-origin', circuit => circuit.map(record => { if (record.type !== 'simulation_eye_diagram') return record; const { time_origin_ms, ...rest } = record; return rest }), /explicit finite timeOrigin|time_origin_ms|timeOrigin/i],
]
const cases = []
for (const [name, mutate, expected] of mutations) {
  const circuitJson = mutate(structuredClone(original))
  const outputDir = join(dirname(destination), 'negative-runs', `${name}-${Date.now()}`)
  let rejection
  await assert.rejects(async () => {
    try {
      await runPipeline({ circuitJson, modeling, outputDir, baseDir: join(project, dirname(receipt.project.entry)), tools: { fasthenry: '/does-not-exist', fastercap: '/does-not-exist', ngspice: '/does-not-exist' } })
    } catch (error) { rejection = error.message; throw error }
  }, expected, `${name}: reject the declared contract violation`)
  await assert.rejects(stat(outputDir), { code: 'ENOENT' }, `${name}: fail before creating output or spending solver work`)
  cases.push({ name, status: 'passed', error: rejection, noOutputCreated: true, noSolverRun: true })
}
await mkdir(dirname(destination), { recursive: true })
await writeFile(destination, JSON.stringify({ status: 'passed', positiveRun: positive, testedBoundary: 'Installed runner rejects invalid serialized native declarations before solver work; core TSX render diagnostics are checked separately', cases }, null, 2) + '\n')
console.log(`Independent negative contract checks passed: ${destination}`)
