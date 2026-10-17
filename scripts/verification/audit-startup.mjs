import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { declaredDcSupplies } from './independent-helpers.mjs'

// Numerical/characterization checks for these delivered fixtures, not absolute
// maximum ratings, an eye mask, or a device/protocol compliance test.
function modelTables(text, name) {
  const headers = [...text.matchAll(/^\[([^\]]+)\][ \t]*(.*)$/gm)].map(match => ({ key: match[1].replaceAll('_', ' ').toLowerCase(), value: match[2].trim(), start: match.index, body: match.index + match[0].length }))
  const model = headers.find(header => header.key === 'model' && header.value === name)
  assert.ok(model, `Original selected model ${name}`)
  const end = headers.find(header => header.key === 'model' && header.start > model.start)?.start ?? text.length
  const body = header => text.slice(header.body, headers.find(next => next.start > header.start)?.start ?? end)
  const ranges = {}
  for (const header of headers.filter(header => header.start > model.start && header.start < end && ['pullup', 'pulldown', 'power clamp', 'gnd clamp'].includes(header.key))) {
    const volts = body(header).split(/\r?\n/).map(line => line.split('|')[0].trim().split(/\s+/)[0]).filter(token => /^[+-]?(?:\d|\.\d)/.test(token)).map(Number)
    assert.ok(volts.length > 1 && volts.every(Number.isFinite), 'Original numeric I/V voltage domain')
    ranges[header.key] = [Math.min(...volts), Math.max(...volts)]
  }
  const threshold = key => Number(body(model).match(new RegExp(`^${key}\\s*=?\\s*([+-]?[\\d.eE]+)`, 'mi'))?.[1])
  return { ranges, vinl: threshold('Vinl'), vinh: threshold('Vinh') }
}

function dcPotentials(sources) {
  const known = new Map([['0', 0]])
  for (let pass = 0; pass <= sources.length; pass++) for (const source of sources) {
    const p = source.positiveNode, n = source.negativeNode
    if (known.has(n)) known.set(p, known.get(n) + source.voltageV)
    else if (known.has(p)) known.set(n, known.get(p) - source.voltageV)
  }
  return known
}

export async function auditStartup({ out, circuit, run, vendorIbis, nodeMap, csv }) {
  const potentials = dcPotentials(await declaredDcSupplies(out,circuit,nodeMap,await readFile(join(out,run.directory,'simulation.cir'),'utf8')))
  const pins = vendorIbis.flatMap(model => model.pins.map(pin => ({ ...pin, modelId: model.modelId, component: model.component })))
  const spans = pins.map(pin => Math.abs(potentials.get(nodeMap.nodes[pin.references.pullup]) - potentials.get(nodeMap.nodes[pin.references.pulldown]))).filter(value => Number.isFinite(value) && value > 0)
  assert.ok(spans.length, 'Delivered fixture has declared physical DC rail potentials')
  const broadLimitV = 4 * Math.max(...spans)
  for (const probe of run.probes) for (const row of csv.rows) assert.ok(Math.abs(row[probe.column]) <= broadLimitV, `Raw startup/range sanity: ${probe.name} ${row[probe.column]}V exceeds broad ${broadLimitV}V guard; no eye gate hides raw samples`)
  const evidence = { broadNumericalLimitV: broadLimitV, scope: 'Raw numerical sanity only; not manufacturer absolute maximum or compliance', cmos: [] }
  const cmos = pins.filter(pin => pin.component === 'LVC1G04_DCK')
  if (!cmos.length) return evidence
  const driver = cmos.find(pin => pin.runState.mode === 'output' && pin.runState.enabled)
  const receiver = cmos.find(pin => pin.runState.mode === 'input')
  assert.ok(driver?.stimulus && receiver, 'CMOS fixture has its explicit output-pad control and input model')
  const thresholdData = modelTables(await readFile(join(out, 'inputs/ibis', `${receiver.modelId}.ibs`), 'utf8'), receiver.selectedModel)
  assert.ok(Number.isFinite(thresholdData.vinl) && Number.isFinite(thresholdData.vinh), 'Original vendor CMOS logic thresholds')
  const quietEnd = driver.stimulus.transitions[0]?.time ?? run.durationSeconds
  assert.ok(quietEnd > csv.rows[0][0], 'This fixture declares a nonzero initial quiet interval')
  for (const probe of run.probes) {
    const pin = cmos.find(pin => pin.sourcePortId === probe.signalSourceId)
    assert.ok(pin, 'CMOS observed physical pad belongs to its original selected vendor model')
    const data = modelTables(await readFile(join(out, 'inputs/ibis', `${pin.modelId}.ibs`), 'utf8'), pin.selectedModel)
    let minimumV = -Infinity, maximumV = Infinity
    for (const [table, [lower, upper]] of Object.entries(data.ranges)) {
      const inverted = ['pullup', 'power clamp'].includes(table)
      const reference = { pullup: 'pullup', pulldown: 'pulldown', 'power clamp': 'powerClamp', 'gnd clamp': 'groundClamp' }[table]
      const rail = potentials.get(nodeMap.nodes[pin.references[reference]])
      assert.ok(Number.isFinite(rail), 'Characterized table uses the actual declared reference rail')
      minimumV = Math.max(minimumV, inverted ? rail - upper : rail + lower)
      maximumV = Math.min(maximumV, inverted ? rail - lower : rail + upper)
    }
    assert.ok(Number.isFinite(minimumV) && Number.isFinite(maximumV) && minimumV < maximumV, 'Nonempty original vendor I/V characterization domain')
    const referenceV = potentials.get(probe.referenceNode)
    assert.ok(Number.isFinite(referenceV), 'CMOS probe has a declared DC ground/reference potential')
    let quietSamples = 0, samplesOutsideCharacterizedDomain = 0
    for (const row of csv.rows) {
      const padV = row[probe.column] + referenceV
      if (padV < minimumV - 1e-9 || padV > maximumV + 1e-9) {
        samplesOutsideCharacterizedDomain++
        if (pin.runState.mode === 'output') assert.fail(`CMOS raw output ${probe.name}: ${padV}V outside original I/V characterization [${minimumV},${maximumV}]V`)
      }
      if (row[0] < quietEnd) {
        const relative = padV - potentials.get(nodeMap.nodes[driver.references.pulldown])
        assert.ok(driver.stimulus.initialState === 0 ? relative <= thresholdData.vinl : relative >= thresholdData.vinh, `CMOS startup ${probe.name}: explicit initial pad state ${driver.stimulus.initialState} disagrees with ${relative}V before the first transition`)
        quietSamples++
      }
    }
    evidence.cmos.push({ probeId: probe.simulationVoltageProbeId, initialPadState: driver.stimulus.initialState, firstObservedV: csv.rows[0][probe.column], initialQuietEndSeconds: quietEnd, quietSamples, vendorVinlV: thresholdData.vinl, vendorVinhV: thresholdData.vinh, characterizedAbsolutePadDomainV: [minimumV, maximumV], samplesOutsideCharacterizedDomain, extrapolationMeaning: samplesOutsideCharacterizedDomain ? 'Input current requires endpoint-held extrapolation outside the vendor table; this is a modeling approximation, not measured characterization' : 'No out-of-domain samples', rawStartupIncluded: true })
  }
  return evidence
}
