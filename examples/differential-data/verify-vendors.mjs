import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { loadIbisSource, parseIbis, sourceHash } from "@tscircuit/ibis-to-spice"

const lock = JSON.parse(await readFile(new URL("../vendor-models.lock.json", import.meta.url)))
const results = []
for (const [name, vendor] of Object.entries(lock.models)) {
  const response = await fetch(vendor.url)
  assert.equal(response.ok, true, `${name}: HTTP ${response.status}`)
  const archive = new Uint8Array(await response.arrayBuffer())
  assert.equal(archive.byteLength, vendor.archiveBytes)
  assert.equal(createHash("sha256").update(archive).digest("hex"), vendor.archiveSha256)
  const source = await loadIbisSource({ sourceUrl: vendor.url, archivePath: vendor.archivePath, sha256: vendor.sha256 },
    async () => new Response(archive))
  assert.equal(sourceHash(source), vendor.sha256)
  assert.equal(new TextEncoder().encode(source).length, vendor.fileBytes)
  const document = parseIbis(source)
  const component = document.components[vendor.component]
  assert.ok(component, `${name}: component missing`)
  for (const [pin, expected] of Object.entries(vendor.signalPins)) {
    const actual = component.pins[pin]
    assert.ok(actual, `${name}: missing physical pin ${pin}`)
    assert.equal(actual.signal, expected.signal)
    const options = document.selectors[actual.model] ?? [actual.model]
    assert.ok(options.includes(expected.model), `${name}.${pin}: selected model is not permitted`)
    const buffer = document.getBuffer(expected.model)
    assert.equal(buffer.type.toLowerCase(), expected.modelType.toLowerCase())
    assert.equal(buffer.voltage[0], vendor.supplyV)
    if (buffer.type.toLowerCase() !== "input") {
      for (const edge of ["rising", "falling"]) {
        const fixtures = buffer.waveforms.filter(w => w.kind === edge)
        assert.equal(fixtures.length, 2, `${name}.${pin}: ${edge} fixture count`)
        assert.ok(fixtures.every(w => w.resistance > 0))
      }
    }
  }
  for (const [pin, signal] of Object.entries(vendor.supplyPins)) {
    assert.equal(component.pins[pin].signal, signal)
    assert.ok(["power", "gnd"].includes(component.pins[pin].model.toLowerCase()))
  }
  results.push({ name, component: vendor.component, archiveSha256: vendor.archiveSha256,
    sourceSha256: sourceHash(source), selectedPins: vendor.signalPins, status: "verified" })
}
console.log(JSON.stringify({ results }, null, 2))
