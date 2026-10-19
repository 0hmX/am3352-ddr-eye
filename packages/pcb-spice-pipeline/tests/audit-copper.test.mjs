import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { auditMatrices } from '../../../scripts/verification/audit-matrices.mjs'
import { auditGroundCopper } from '../../../scripts/verification/audit-general.mjs'
import { independentlyCheckMatrices } from '../scripts/audit-eye.mjs'

// Hand-written native-output fixtures: no pipeline geometry or matrix helpers.
async function nativeFixture(t, routed, lanes) {
  const out = await mkdtemp(join(tmpdir(), 'pcb-independent-copper-'))
  t.after(() => rm(out, { recursive: true, force: true }))
  const dir = join(out, 'stage-0'), dimension = lanes + 1, frequency = 1e8
  await mkdir(join(dir, 'refinement'), { recursive: true })
  const cell = { stage: 0, conductors: Array.from({ length: dimension }, (_, i) => ({ name: i === lanes ? 'return' : `sig${i}`, lengthM: .01, widthM: routed && i === lanes ? 0 : .0001, thicknessM: .000035 })) }
  if (routed) cell.routedCopper = { signals: Array.from({ length: lanes }, () => ({ segments: [
    { a: [0, 0, 0], b: [3, 4, 0], widthMm: .1, thicknessMm: .035 },
    { a: [3, 4, 0], b: [3, 4, 12], widthMm: .2, thicknessMm: .025 },
  ] })) }
  const modeling = { reduction: routed ? 'routed-copper' : 'straightened-stages', conductivitySm: 58e6, extraction: { modelHz: frequency } }
  const resistance = routed ? .005 / (58e6 * .0001 * .000035) + .012 / (58e6 * .0002 * .000025) : .01 / (58e6 * .0001 * .000035)
  const returnR = .1 * dimension, returnL = 1e-9 * dimension, rowSum = (4 - .5 * lanes) * 1e-12
  const extraction = {
    R: Array.from({ length: lanes }, (_, i) => Array.from({ length: lanes }, (_, j) => returnR + (i === j ? .1 * (i + 1) : 0))),
    L: Array.from({ length: lanes }, (_, i) => Array.from({ length: lanes }, (_, j) => returnL + (i === j ? 1e-9 * (i + 1) : 0))),
    C: Array.from({ length: lanes }, (_, i) => Array.from({ length: lanes }, (_, j) => (i === j ? 4e-12 : -.5e-12) - rowSum / dimension)),
    checks: { analyticResistanceOhm: Array(routed ? lanes : dimension).fill(resistance) },
    conversions: { capacitanceScaleToFarads: routed ? 1e-3 : 1, capacitanceSolverCoordinateUnits: routed ? 'mm' : 'm' },
  }
  await writeFile(join(dir, 'refinement/Zc.mat'), `Impedance matrix for frequency = ${frequency} ${dimension} x ${dimension}\n` +
    Array.from({ length: dimension }, (_, i) => Array.from({ length: dimension }, (_, j) => i === j ? `${.1 * (i + 1)} ${2 * Math.PI * frequency * 1e-9 * (i + 1)}j` : '0 0j').join(' ')).join('\n') + '\n')
  const capUnit = routed ? 1e-9 : 1e-12
  await writeFile(join(dir, 'fastercap.stdout.log'), `Capacitance matrix is:\nDimension ${dimension} x ${dimension}\n` +
    cell.conductors.map((conductor, i) => `g_${conductor.name} ` + Array.from({ length: dimension }, (_, j) => (i === j ? 4 : -.5) * capUnit).join(' ')).join('\n') + '\n')
  await writeFile(join(dir, 'channel.lst'), routed ? '* Actual copper in millimetres\n' : '* Surfaces in metres\n')
  if (routed) for (const conductor of cell.conductors) await writeFile(join(dir, `${conductor.name}.txt`), '* Closed actual copper; millimetres\n')
  const save = () => writeFile(join(dir, 'extraction.json'), JSON.stringify(extraction))
  await save()
  return { out, dir, cell, modeling, extraction, save, resistance }
}

for (const [label, audit] of [['general', auditMatrices], ['package', independentlyCheckMatrices]]) {
  test(`${label} independent audit preserves legacy metres and routed millimetres for one to three signals`, async t => {
    for (const routed of [false, true]) for (const lanes of [1, 3]) await t.test(`${routed ? 'routed' : 'legacy'}: ${lanes} lanes`, async t => {
      const fixture = await nativeFixture(t, routed, lanes), result = await audit(fixture.out, fixture.cell, fixture.modeling)
      assert.equal(result.capacitanceScaleToFarads, routed ? 1e-3 : 1)
      assert.ok(result.C[0][0] > 1e-12 && result.C[0][0] < 4e-12)
      const dc = result.dcResistanceOhm ?? result.independentDcResistanceOhm
      assert.deepEqual(dc, Array(routed ? lanes : lanes + 1).fill(fixture.resistance))
      assert.equal(result.groundDcResistanceCheck.status, routed ? 'not-applicable' : 'checked')
      if (routed) assert.match(result.groundDcResistanceCheck.reason, /polygon ground plane.*no uniform-bar/i)
    })
  })
  test(`${label} independent audit rejects coherent but incorrectly scaled routed capacitance`, async t => {
    const fixture = await nativeFixture(t, true, 2)
    fixture.extraction.C = fixture.extraction.C.map(row => row.map(value => value * 1000))
    await fixture.save()
    await assert.rejects(audit(fixture.out, fixture.cell, fixture.modeling), /raw-solver C/)
    fixture.extraction.conversions.capacitanceScaleToFarads = 1
    await fixture.save()
    await assert.rejects(audit(fixture.out, fixture.cell, fixture.modeling), /scale agrees with input geometry/)
  })
  test(`${label} independent audit rejects false captured coordinate-unit evidence`, async t => {
    const fixture = await nativeFixture(t, true, 2)
    await writeFile(join(fixture.dir, 'sig0.txt'), '* Wrong panel units; metres\n')
    await assert.rejects(audit(fixture.out, fixture.cell, fixture.modeling), /panels use mm/)
  })
}

test('ground audit follows reference-net connectivity and preserves real polygon cutouts', () => {
  const outer = [[-1, -2], [11, -2], [11, 2], [-1, 2]], cutout = [[4, -.25], [6, -.25], [6, .25], [4, .25]]
  const circuit = [
    ...['driver-ground', 'receiver-ground'].map(id => ({ type: 'source_port', source_port_id: id })),
    { type: 'source_net', source_net_id: 'ground', is_ground: true },
    { type: 'source_trace', connected_source_port_ids: ['driver-ground'], connected_source_net_ids: ['ground'] },
    { type: 'source_trace', connected_source_port_ids: ['receiver-ground'], connected_source_net_ids: ['ground'] },
    { type: 'pcb_copper_pour', pcb_copper_pour_id: 'plane', source_net_id: 'ground', layer: 'bottom', shape: 'brep', brep_shape: {
      outer_ring: { vertices: outer.map(([x, y]) => ({ x, y })) }, inner_rings: [{ vertices: cutout.map(([x, y]) => ({ x, y })) }],
    } },
  ]
  const modeling = { channelReference: { sourcePortId: 'driver-ground' }, stackup: [{ name: 'bottom', zMinMm: -.235, zMaxMm: -.2 }] }
  const copper = { sourceNetId: 'ground', referenceSourcePortIds: ['driver-ground', 'receiver-ground'], pours: [{ pcbCopperPourId: 'plane', layer: 'bottom', polygon: [[...outer].reverse(), cutout], zMinMm: -.235, zMaxMm: -.2 }] }
  const geometry = { cells: [{ stage: 0, routedCopper: copper }] }
  assert.equal(auditGroundCopper(circuit, modeling, geometry)[0].boundariesAndCutoutsPreserved, true)
  copper.pours[0].polygon = [outer]
  assert.throws(() => auditGroundCopper(circuit, modeling, geometry), /every cutout preserved/)
  copper.pours[0].polygon = [outer, cutout]
  copper.referenceSourcePortIds[1] = 'unconnected-ground'
  assert.throws(() => auditGroundCopper(circuit, modeling, geometry), /connect electrically to GND/)
})
