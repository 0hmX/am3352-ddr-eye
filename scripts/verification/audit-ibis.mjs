import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sha256, json, zipMember, vendorPinEvidence, bitSchedule, close } from './independent-helpers.mjs'

function one(elements, predicate, label) {
  const matches = elements.filter(predicate)
  assert.equal(matches.length, 1, label)
  return matches[0]
}

export async function auditIbisSource(out, definition, source, ibsBytes) {
  const ibsSha256 = sha256(ibsBytes)
  assert.ok(typeof source.rawSourceFile === 'string' && source.rawSourceFile, 'Exact raw source file is captured')
  const rawBytes = await readFile(join(out, source.rawSourceFile))
  const rawSourceSha256 = sha256(rawBytes)
  assert.equal(rawSourceSha256, source.rawSourceSha256, 'Recorded raw download/read/inline bytes')
  if (definition.url) assert.ok(definition.sha256, 'Remote raw vendor bytes have a declared content lock')
  if (definition.sha256) assert.equal(rawSourceSha256, definition.sha256.toLowerCase(), 'source.sha256 verifies raw resource bytes')
  if (definition.archive) {
    assert.ok(!Object.hasOwn(definition.archive, 'sha256'), 'Legacy archive.sha256 is rejected; use source.sha256 for the raw resource')
    const archive = await readFile(join(out, source.archiveFile))
    assert.deepEqual(archive, rawBytes, 'Archived input is the exact raw downloaded/read resource')
    assert.equal(sha256(archive), source.archiveSha256, 'Original ZIP container fingerprint')
    assert.equal(sha256(zipMember(archive, definition.archive.member)), ibsSha256, 'Original archive independently decodes the exact executed IBIS bytes')
    if (definition.archive.memberSha256) assert.equal(ibsSha256, definition.archive.memberSha256.toLowerCase(), 'archive.memberSha256 verifies the extracted member bytes')
  } else {
    assert.deepEqual(rawBytes, ibsBytes, 'Plain IBIS input retains exact raw bytes')
    if (definition.content !== undefined) assert.deepEqual(rawBytes, Buffer.from(definition.content, 'utf8'), 'Inline checksum refers to UTF-8 content bytes')
  }
  return { ibsSha256, rawSourceSha256, archiveSha256: definition.archive ? rawSourceSha256 : null }
}

export async function auditIbis(out, experimentDir, circuit, run) {
  const assemblies = await json(join(experimentDir, 'native-ibis-assembly.json'))
  const declaredModels = circuit.filter(element => element.type === 'simulation_ibis_model')
  assert.equal(assemblies.length, declaredModels.length, 'Each native model attachment is assembled')
  const states = circuit.filter(element => element.type === 'simulation_ibis_pin_state' && element.simulation_experiment_id === run.simulationExperimentId)
  const stimuli = circuit.filter(element => element.type === 'simulation_digital_stimulus' && element.simulation_experiment_id === run.simulationExperimentId)
  const nodeMap = await json(join(out, 'electrical-node-map.json'))
  const deck = await readFile(join(experimentDir, 'simulation.cir'), 'utf8')
  const declaredDcRailNodes = new Set(circuit.filter(element => element.type === 'simulation_voltage_source' && !element.wave_shape)
    .flatMap(source => [nodeMap.nodes[source.terminal1_source_port_id], nodeMap.nodes[source.terminal2_source_port_id]]))
  assert.equal(new Set(states.map(state => state.source_port_id)).size, states.length, 'Unique fixed state for each physical pin')
  assert.equal(new Set(stimuli.map(stimulus => stimulus.source_port_id)).size, stimuli.length, 'No duplicate driver stimulus')
  const evidence = []
  for (const [modelIndex, assembly] of assemblies.entries()) {
    const declared = one(declaredModels, model => model.simulation_ibis_model_id === assembly.simulationIbisModelId, 'Exact native model association')
    const definition = assembly.definition, metadata = assembly.metadata, source = assembly.sourceEvidence
    assert.deepEqual(definition.source, declared.source, 'Original native source descriptor')
    assert.deepEqual(source.source, declared.source, 'Downloaded source retains its native descriptor')
    assert.equal(definition.component, declared.component)
    assert.deepEqual(definition.pinMap, declared.pin_to_source_port_map, 'Physical IBIS pin maps to the actual local source-port ID')
    assert.deepEqual(definition.modelSelections, declared.model_selections)
    assert.equal(definition.corner, declared.corner)
    assert.equal(definition.packagePolicy, declared.package_policy)
    const bytes = await readFile(join(out, source.ibsFile))
    const digest = sha256(bytes)
    assert.equal(digest, source.sourceSha256)
    assert.equal(digest, assembly.sourceSha256)
    assert.equal(digest, metadata.sourceSha256)
    const checksums = await auditIbisSource(out, definition.source, source, bytes)
    const lib = await readFile(join(experimentDir, `${assembly.simulationIbisModelId}.lib`))
    assert.equal(sha256(lib), assembly.spiceSha256, 'Executed model-library bytes')
    const wrapper = lib.toString('utf8').match(/^\.subckt\s+(\S+)\s+([^\r\n]+)/mi)
    assert.ok(wrapper, 'Native converter component wrapper')
    const terminalNodes = wrapper[2].trim().split(/\s+/).map(terminal => {
      const sourceId = assembly.spicePinMapping[terminal]
      assert.ok(sourceId && Object.hasOwn(nodeMap.nodes, sourceId), 'Native SPICE terminal maps to a physical circuit contact')
      return nodeMap.nodes[sourceId]
    })
    assert.ok(deck.split('\n').includes(`XIBIS${modelIndex} ${terminalNodes.join(' ')} IBIS${modelIndex}_${wrapper[1]}`), 'Actual deck instantiates native buffers on the audited physical signal/reference nodes')
    const selected = metadata.pins.map(pin => ({ physicalPin: pin.physicalPin, localPort: pin.port, model: pin.model, mode: pin.runState.mode }))
    for (const [physicalPin, localPort] of Object.entries(definition.pinMap)) if (!metadata.pins.some(pin => pin.physicalPin === physicalPin)) selected.push({ physicalPin, localPort })
    const vendor = vendorPinEvidence(bytes.toString('utf8'), definition.component, selected, definition.corner)
    assert.equal(metadata.packageData.mappedPins.length, selected.length, 'Excluded package metadata retains every mapped signal/reference pin')
    for (const reported of metadata.packageData.mappedPins) {
      const original = one(vendor, pin => pin.physicalPin === reported.physicalPin, 'Reported package pin belongs to original vendor table')
      assert.equal(reported.port, original.localPort)
      assert.equal(reported.role, original.supplyType ? 'reference' : 'signal')
      for (const [key, value] of Object.entries(original.package)) {
        if (value === null) assert.equal(reported[key], null, 'Unavailable package value is explicitly null')
        else close(reported[key], value, `Excluded vendor ${key} is preserved in metadata`, 1e-10, key === 'resistanceOhms' ? 1e-15 : 1e-27)
      }
    }
    const pins = []
    for (const pin of metadata.pins) {
      const port = one(circuit, element => element.type === 'source_port' && element.source_port_id === pin.port, 'Modeled pin is an actual TSX port')
      assert.equal(port.source_component_id, declared.source_component_id, 'Modeled pin belongs to attached chip instance')
      assert.equal(definition.pinMap[pin.physicalPin], pin.port)
      const original = vendor.find(row => row.physicalPin === pin.physicalPin)
      assert.equal(pin.modelType, original.modelType)
      assert.equal(pin.polarityDeclared, Boolean(original.polarity))
      assert.equal(pin.polarity, original.polarity?.toLowerCase() ?? 'non-inverting')
      if (original.enable) assert.equal(pin.enable, original.enable.toLowerCase())
      const state = one(states, element => element.source_port_id === pin.port, 'Explicit run state for every modeled signal')
      assert.deepEqual(pin.runState, { mode: state.mode, ...(state.mode === 'output' ? { enabled: state.enabled } : {}) })
      const controls = stimuli.filter(stimulus => stimulus.source_port_id === pin.port)
      const enabled = state.mode === 'output' && state.enabled
      assert.equal(controls.length, enabled ? 1 : 0, 'Enabled output has exactly one explicit control; input/disabled output has none')
      if (pin.enable && state.mode === 'output') assert.equal(pin.enableControlLevel, Number(state.enabled) ^ Number(pin.enable === 'active-low'), 'Boolean enable intent maps through vendor enable polarity')
      for (const referenceId of Object.values(pin.references)) {
        assert.ok(Object.values(definition.pinMap).includes(referenceId), 'Reference is part of the declared physical pin map')
        const supply = vendor.find(row => row.localPort === referenceId && row.supplyType)
        assert.ok(supply, 'Reference uses an actual vendor POWER/GND contact')
        assert.ok(declaredDcRailNodes.has(nodeMap.nodes[referenceId]), 'This example explicitly energizes each model rail through its declared ideal DC supply')
      }
      let schedule
      if (enabled) {
        const declaredExperiment = one(circuit, element => element.type === 'simulation_experiment' && element.simulation_experiment_id === run.simulationExperimentId, 'Run timing for independent control expansion')
        // Assembly duration is recorded in the converter's millisecond convention.
        close(assembly.run.duration, declaredExperiment.end_time_ms, 'Converter consumes declared experiment duration')
        schedule = bitSchedule(controls[0], assembly.run.duration, pin.polarity)
        assert.equal(schedule.sha256, pin.stimulusHash, 'Initial state and explicit bit sequence apply inversion exactly once')
      } else assert.equal(pin.stimulusHash, undefined)
      pins.push({ ...original, sourcePortId: pin.port, runState: pin.runState, enableControlLevel: pin.enableControlLevel, references: pin.references, stimulus: schedule })
    }
    evidence.push({ modelId: assembly.simulationIbisModelId, sourceComponentId: declared.source_component_id, component: definition.component, source: definition.source, sourceSha256: digest, checksums, packagePolicy: definition.packagePolicy, omissions: metadata.omissions, differentialPins: metadata.differentialPins, packageData: metadata.packageData, pins, vendorSupplyPins: vendor.filter(pin => pin.supplyType) })
  }
  return evidence
}
