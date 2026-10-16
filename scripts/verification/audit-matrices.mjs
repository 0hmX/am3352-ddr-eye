import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { close, json } from './independent-helpers.mjs'

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

export async function auditMatrices(out, cell, modeling) {
  const stage = join(out, `stage-${cell.stage}`)
  const extraction = await json(join(stage, 'extraction.json'))
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
  assert.ok(complex.every(row => row.length === 2 * dimension && row.every(Number.isFinite)))
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
  const primitiveC = symmetric(capLines.map(row => row.slice(1).map(Number)))
  const rowSums = primitiveC.map(row => row.reduce((sum, value) => sum + value, 0))
  const total = rowSums.reduce((sum, value) => sum + value, 0)
  assert.ok(total > 0, 'Finite reference-reduction capacitance')
  const C = Array.from({ length: returnIndex }, (_, i) => Array.from({ length: returnIndex }, (_, j) => primitiveC[i][j] - rowSums[i] * rowSums[j] / total))
  for (const [kind, matrix] of Object.entries({ R, L, C })) {
    positiveEnergy(matrix, kind)
    assert.equal(extraction[kind].length, returnIndex)
    matrix.forEach((row, i) => row.forEach((value, j) => close(value, extraction[kind][i][j], `Independent raw-solver ${kind}[${i}][${j}]`, 1e-10, kind === 'C' ? 1e-23 : kind === 'L' ? 1e-20 : 1e-12)))
  }
  const dcResistanceOhm = cell.conductors.map(conductor => conductor.lengthM / (modeling.conductivitySm * conductor.widthM * conductor.thicknessM))
  dcResistanceOhm.forEach((value, i) => close(value, extraction.checks.analyticResistanceOhm[i], 'Geometry DC resistance independently recomputed'))
  return { stage: cell.stage, signalConductors: returnIndex, modelFrequencyHz: frequency, R, L, C, dcResistanceOhm }
}
