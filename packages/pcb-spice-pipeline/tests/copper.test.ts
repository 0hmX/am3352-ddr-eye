import test from 'node:test'
import assert from 'node:assert/strict'
import { geometryFromCircuitJson, fastHenryDeck, fasterCapDeck } from '../src/geometry.js'
import { groundMesh } from '../src/copper.js'
import { loadEntry } from '../src/pipeline.mjs'
import { groundPlaneFixture, routedGroundPlaneFixture } from './fixtures/ground-plane.js'

function closedSurfaceVolume(surface: string): number {
  assert.match(surface.split('\n')[0], /\bmillimetres\b/)
  const panels = surface.split('\n').filter(r => /^[TQ] /.test(r)).map(row => {
    const values = row.split(' ').slice(2).map(value => Number(value) * 1e-3)
    return Array.from({ length: values.length / 3 }, (_, i) => values.slice(i * 3, i * 3 + 3))
  })
  const key = (p: number[]) => p.map(n => n.toPrecision(12)).join(',')
  const vertices = [...new Map(panels.flat().map(p => [key(p), p])).values()]
  const edges = new Map<string, { count: number; orientation: number }>()
  let volume = 0
  for (const p of panels) {
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length], d = b.map((v, j) => v - a[j]), length2 = d.reduce((s, v) => s + v * v, 0)
      assert.ok(length2 > 0, 'surface edges must have nonzero length')
      // A slab union can split one side of an edge into several collinear edges.
      const cuts = vertices.flatMap(v => {
        const t = v.reduce((s, n, j) => s + (n - a[j]) * d[j], 0) / length2
        return t >= -1e-10 && t <= 1 + 1e-10 && Math.hypot(...v.map((n, j) => n - a[j] - t * d[j])) < 1e-13 ? [{ t, v }] : []
      }).sort((a, b) => a.t - b.t)
      for (let j = 1; j < cuts.length; j++) {
        const [u, v] = [key(cuts[j - 1].v), key(cuts[j].v)], id = [u, v].sort().join(' '), edge = edges.get(id) ?? { count: 0, orientation: 0 }
        edge.count++; edge.orientation += u < v ? 1 : -1; edges.set(id, edge)
      }
    }
    for (let i = 1; i < p.length - 1; i++) {
      const [a, b, c] = [p[0], p[i], p[i + 1]]
      volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6
    }
  }
  assert.ok(edges.size > 0)
  for (const edge of edges.values()) assert.deepEqual(edge, { count: 2, orientation: 0 }, 'each solid edge must have two oppositely wound faces')
  return volume
}

test('ground selection follows reference connectivity and is_ground, independent of net name or proximity', () => {
  const { circuit, modeling } = groundPlaneFixture()
  const net = circuit.find(e => e.type === 'source_net' && e.source_net_id === 'ground')!
  if (net.type !== 'source_net') throw Error('fixture')
  net.name = 'reference-copper'
  const pour = circuit.find(e => e.type === 'pcb_copper_pour')!
  if (pour.type !== 'pcb_copper_pour') throw Error('fixture')
  circuit.push({ ...pour, pcb_copper_pour_id: 'power-plane', source_net_id: 'power' })
  const g = geometryFromCircuitJson(circuit, modeling), copper = g.cells[0].routedCopper!
  assert.equal(copper.sourceNetId, 'ground')
  assert.equal(copper.sourceNetName, 'reference-copper')
  assert.deepEqual(copper.pours.map(p => p.pcbCopperPourId), ['ground-plane'])
  assert.deepEqual(copper.referenceSourcePortIds, ['ground0', 'ground1'])
  assert.deepEqual(copper.pours[0].polygon[1], [[4, .25], [6, .25], [6, -.25], [4, -.25]])
  assert.ok(Math.abs(copper.pours[0].zMaxMm - copper.pours[0].zMinMm - .035) < 1e-12)
})

test('routed copper layers require a positive dielectric gap', () => {
  for (const zMaxMm of [0, .01, .035]) {
    const { circuit, modeling } = groundPlaneFixture()
    modeling.stackup.find(layer => layer.name === 'bottom')!.zMaxMm = zMaxMm
    assert.throws(() => geometryFromCircuitJson(circuit, modeling), /stackup.*positive dielectric gap/)
  }
})

test('signal route endpoints must reach the physical source and receiver pad layers', () => {
  for (const id of ['b0', 'b2']) {
    const { circuit, modeling } = groundPlaneFixture()
    const port = circuit.find(e => e.type === 'pcb_port' && e.pcb_port_id === id)!
    if (port.type !== 'pcb_port') throw Error('fixture')
    port.layers = ['bottom']
    assert.throws(() => geometryFromCircuitJson(circuit, modeling), /endpoint_layer/)
  }
})

test('missing/ambiguous ground, missing geometry and disconnected references never fall back to a strip', () => {
  for (const kind of ['flag', 'ambiguous', 'pour', 'return'] as const) {
    const { circuit, modeling } = groundPlaneFixture()
    if (kind === 'flag') { const net = circuit.find(e=>e.type==='source_net'&&e.source_net_id==='ground')!; if(net.type==='source_net') net.is_ground=false }
    if (kind === 'ambiguous') circuit.push({ type:'source_net',source_net_id:'other',name:'OTHER',is_ground:true,member_source_group_ids:[] }, { type:'source_trace',source_trace_id:'short',connected_source_port_ids:['ground0'],connected_source_net_ids:['other'] })
    if (kind === 'pour') circuit.splice(circuit.findIndex(e=>e.type==='pcb_copper_pour'),1)
    if (kind === 'return') { const trace=circuit.find(e=>e.type==='source_trace'&&e.source_trace_id==='ground-trace1')!; if(trace.type==='source_trace') trace.connected_source_net_ids=[] }
    assert.throws(()=>geometryFromCircuitJson(circuit,modeling),/ground_(net|geometry|reference)/)
  }
})

test('receiver ground is inferred from IBIS references and conflicting or missing bindings fail', () => {
  const { circuit, modeling } = groundPlaneFixture()
  delete modeling.groundReturn
  assert.deepEqual(geometryFromCircuitJson(circuit, modeling).cells[0].routedCopper!.referenceSourcePortIds, ['ground0', 'ground1'])
  const model = circuit.find(e => e.type === 'simulation_ibis_model')!
  if (model.type !== 'simulation_ibis_model') throw Error('fixture')
  model.ibis_pin_name_to_reference_source_port_ids!['4'].ground_clamp_reference_source_port_id = 'ground0'
  assert.throws(() => geometryFromCircuitJson(circuit, modeling), /ground_reference/)
  delete model.ibis_pin_name_to_reference_source_port_ids
  assert.throws(() => geometryFromCircuitJson(circuit, modeling), /ground_reference/)
})

test('physical ground contacts require copper pads and cannot be placed in a cutout', () => {
  for (const kind of ['missing-pad', 'cutout'] as const) {
    const { circuit, modeling } = groundPlaneFixture()
    if (kind === 'missing-pad') circuit.splice(circuit.findIndex(e => e.type === 'pcb_smtpad'), 1)
    else {
      const port = circuit.find(e => e.type === 'pcb_port' && e.source_port_id === 'ground1')!
      if (port.type !== 'pcb_port') throw Error('fixture')
      port.x = 5; port.y = 0
    }
    assert.throws(() => geometryFromCircuitJson(circuit, modeling), /ground_connection/)
  }
})

test('ground routes preserve the physical pad layer and reject misplaced vias or a via endpoint', () => {
  const valid = routedGroundPlaneFixture(), connection = geometryFromCircuitJson(valid.circuit, valid.modeling).cells[0].routedCopper!.connections[0]
  assert.deepEqual(connection.terminals, [[0, -1, .0175], [1, -1, -.2175]])
  assert.equal(connection.contactRadiusMm, .1)
  for (const kind of ['wrong-layer', 'misplaced-via', 'via-endpoint'] as const) {
    const { circuit, modeling, lead } = routedGroundPlaneFixture()
    if (kind === 'wrong-layer') for (const point of lead.route) { if (point.route_type === 'wire') point.layer = 'bottom' }
    else {
      lead.route.push({ route_type: 'via', x: kind === 'misplaced-via' ? 2 : 1, y: -1, from_layer: 'top', to_layer: 'bottom', hole_diameter: .1 })
      if (kind === 'misplaced-via') lead.route.push({ route_type: 'wire', x: 2, y: -1, layer: 'bottom', width: .1 })
    }
    assert.throws(() => geometryFromCircuitJson(circuit, modeling), kind === 'misplaced-via' ? /via_geometry/ : /ground_connection/)
  }
})

test('FasterCap reference lead and via union forms a closed outward-facing solid', () => {
  const { circuit, modeling } = routedGroundPlaneFixture(), cell = geometryFromCircuitJson(circuit, modeling).cells[0]
  const files = fasterCapDeck(cell, modeling.extraction)
  for (const name of ['sig0', 'sig1', 'return']) assert.ok(closedSurfaceVolume(files[`${name}.txt`]) > 0)
  assert.ok(closedSurfaceVolume(files['return.txt']) > 47 * .035 * 1e-9, 'ground lead and via add copper to the physical plane')
})

test('bent routes and ground polygon coordinates remain physical and input records stay unchanged', () => {
  const { circuit, modeling } = groundPlaneFixture()
  const trace = circuit.find(e => e.type === 'pcb_trace' && e.pcb_trace_id === 't0')!
  if (trace.type !== 'pcb_trace') throw Error('fixture')
  trace.route.splice(1, 0, { route_type: 'wire', x: 4, y: -1.375, width: .1, layer: 'top' })
  const before = structuredClone(circuit), g = geometryFromCircuitJson(circuit, modeling), copper = g.cells[0].routedCopper!
  assert.deepEqual(circuit, before)
  assert.deepEqual(copper.signals[0].segments.map(s => [s.a, s.b]), [
    [[0, -.375, .0175], [4, -1.375, .0175]], [[4, -1.375, .0175], [10, -.375, .0175]],
  ])
  assert.deepEqual(copper.pours[0].polygon[0], [[-1, -2], [11, -2], [11, 2], [-1, 2]])
  assert.match(fastHenryDeck(g.cells[0], modeling.extraction), /x=0\.004 y=-0\.001375 z=0\.0000175/)
})

test('adaptive ground mesh preserves the cutout and resolves connected finite contact areas', () => {
  const { circuit, modeling } = groundPlaneFixture(), copper = geometryFromCircuitJson(circuit, modeling).cells[0].routedCopper!
  const contacts = copper.connections.map(p => ({ point: [p.terminals[1][0], p.terminals[1][1]] as [number, number], radius: p.contactRadiusMm! }))
  const mesh = groundMesh(copper.pours[0], modeling.extraction.groundMeshMm!, contacts)
  const parents = mesh.points.map((_, i) => i), root = (i: number): number => parents[i] === i ? i : (parents[i] = root(parents[i]))
  for (const [a, b, width] of mesh.edges) {
    assert.ok(Number.isFinite(width) && width > 0)
    parents[root(a)] = root(b)
    for (const t of [0, .25, .5, .75, 1]) {
      const x = mesh.points[a][0] * (1 - t) + mesh.points[b][0] * t, y = mesh.points[a][1] * (1 - t) + mesh.points[b][1] * t
      assert.ok(x >= -1 && x <= 11 && y >= -2 && y <= 2)
      assert.ok(!(x > 4 && x < 6 && y > -.25 && y < .25), 'mesh must not bridge a copper cutout')
    }
  }
  for (const [i, group] of mesh.contacts.entries()) {
    assert.ok(group.length >= 4, 'reference contact must resolve a finite area')
    for (const id of group) {
      assert.equal(root(id), root(mesh.contacts[0][0]))
      assert.ok(Math.hypot(mesh.points[id][0] - contacts[i].point[0], mesh.points[id][1] - contacts[i].point[1]) <= contacts[i].radius)
    }
  }
  assert.throws(() => groundMesh(copper.pours[0], .5, [{ point: [5, 0], radius: .1 }]), /ground_mesh/)
})

test('both native decks use ground polygon cutouts and original trace coordinates', () => {
  const { circuit, modeling } = groundPlaneFixture(), cell = geometryFromCircuitJson(circuit, modeling).cells[0]
  const fh = fastHenryDeck(cell, modeling.extraction), fc = fasterCapDeck(cell, modeling.extraction)
  assert.match(fh,/ground-plane layer=bottom cutouts=1/)
  assert.match(fh,/Eg0_0 /)
  assert.match(fh,/Np0_\d+ x=-0.001 y=-0.002/)
  assert.match(fh,/N0a x=0 y=-0.000375/)
  assert.match(fh,/\.external N2a N2b/)
  assert.match(fc['return.txt'],/T return/)
  assert.match(fc['return.txt'],/Q return/)
  assert.match(fc['channel.lst'].split('\n')[0], /\bmillimetres\b/)
  // Divergence theorem independently verifies the closed, outward-facing solid
  // volume: (12*4 - 2*.5) * .035 mm^3, including the hole side walls.
  const volume = closedSurfaceVolume(fc['return.txt'])
  assert.ok(Math.abs(volume-47*.035*1e-9)<1e-20)
  assert.ok(fh.length < fastHenryDeck(cell,{...modeling.extraction,groundMeshMm:.25}).length)
})

test('default and DDR DQ entries infer the saved GND copper, retain its 392 cutouts and physical references', async () => {
  for(const entry of ['../../../index.circuit.tsx','../../../examples/ddr-dq/index.circuit.tsx']) {
    const input=await loadEntry(new URL(entry,import.meta.url).pathname), g=geometryFromCircuitJson(input.circuitJson,input.modeling), c=g.cells[0].routedCopper!
    assert.equal(g.cells.length,1)
    assert.equal(c.signals.length,entry.includes('ddr-dq')?3:2)
    assert.equal(c.sourceNetId,'source_net_56')
    assert.deepEqual(c.pours.map(p=>p.pcbCopperPourId),['pcb_copper_pour_446','pcb_copper_pour_449','pcb_copper_pour_456'])
    assert.equal(c.pours[0].polygon.length,393)
    assert.deepEqual(c.referenceSourcePortIds,['source_port_0','source_port_325'])
    assert.equal(input.modeling.profiles,undefined)
    assert.equal(c.connections[0].segments.at(-1)!.b[2],-.0175)
    assert.ok(c.signals.every(p=>p.segments.some(s=>s.a[2]!==s.b[2])))
    const deck=fastHenryDeck(g.cells[0],input.modeling.extraction)
    assert.match(deck,/cutouts=392/)
    assert.ok(g.approximations.some(s=>s.includes('ground mesh')))
    if (entry.includes('ddr-dq')) {
      const files = fasterCapDeck(g.cells[0], input.modeling.extraction)
      assert.match(files['channel.lst'].split('\n')[0], /\bmillimetres\b/)
      for (const [filename, surface] of Object.entries(files).filter(([name]) => name.endsWith('.txt'))) {
        assert.match(surface.split('\n')[0], /\bmillimetres\b/)
        const panels = surface.split('\n').filter(row => /^[TQ] /.test(row))
        assert.ok(panels.length > 0)
        for (const [index, row] of panels.entries()) {
          const values = row.split(' ').slice(2).map(value => Number(value) * 1e-3), p = Array.from({ length: values.length / 3 }, (_, i) => values.slice(i * 3, i * 3 + 3))
          const distance = (a: number[], b: number[]) => Math.hypot(...a.map((v, i) => v - b[i]))
          for (let i = 0; i < p.length; i++) assert.ok(distance(p[i], p[(i + 1) % p.length]) >= 1e-13, `${filename} panel ${index}: edge below 1e-13 m`)
          for (let i = 1; i < p.length - 1; i++) {
            const [a, b, c] = [p[0], p[i], p[i + 1]], u = b.map((v, j) => v - a[j]), v = c.map((v, j) => v - a[j])
            const cross = Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])
            const altitude = cross / Math.max(distance(a, b), distance(b, c), distance(c, a))
            assert.ok(altitude >= 1e-13, `${filename} panel ${index}: degenerate triangle with altitude ${altitude} m`)
          }
        }
      }
    }
  }
})
