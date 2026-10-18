import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sha256, json, vendorPinEvidence, bitSchedule, close, declaredDcSupplies } from './independent-helpers.mjs'

function one(elements, predicate, label) {
  const matches = elements.filter(predicate)
  assert.equal(matches.length, 1, label)
  return matches[0]
}

export async function auditIbisSource(out, asset, source, ibsBytes) {
  const ibsSha256 = sha256(ibsBytes)
  assert.ok(typeof source.rawSourceFile === 'string' && source.rawSourceFile, 'Exact raw source file is captured')
  const rawBytes = await readFile(join(out, source.rawSourceFile))
  const rawSourceSha256 = sha256(rawBytes)
  assert.equal(rawSourceSha256, source.rawSourceSha256, 'Recorded raw asset bytes')
  assert.deepEqual(source.ibisModelAsset, asset, 'Exact native asset descriptor')
  assert.ok(['project', 'url'].includes(source.resolvedFrom), 'Model was read from the project or its declared URL')
  assert.deepEqual(rawBytes, ibsBytes, 'Plain IBIS asset retains exact raw bytes')
  assert.equal(source.rawSourceFile, source.ibsFile, 'Executed model is the captured asset without archive extraction')
  const modeling = await json(join(out, 'inputs/modeling.json'))
  const expectedHashes = modeling.ibisModelAssetSha256
  let expectedSha256 = null
  if (expectedHashes !== undefined) {
    assert.ok(expectedHashes !== null && typeof expectedHashes === 'object' && !Array.isArray(expectedHashes), 'ibisModelAssetSha256 must be an asset-path to SHA-256 mapping')
    const path = asset.project_relative_path
    assert.ok(Object.hasOwn(expectedHashes, path) && typeof expectedHashes[path] === 'string' && /^[a-f0-9]{64}$/i.test(expectedHashes[path]), `ibisModelAssetSha256 requires a valid expected hash for ${path}`)
    expectedSha256 = expectedHashes[path].toLowerCase()
    assert.equal(rawSourceSha256, expectedSha256, `Captured asset bytes match the declared expected SHA-256 for ${path}`)
    assert.equal(ibsSha256, expectedSha256, `Executed asset bytes match the declared expected SHA-256 for ${path}`)
    assert.equal(source.sourceSha256, expectedSha256, `Recorded source hash matches the declared expected SHA-256 for ${path}`)
  }
  return { ibsSha256, rawSourceSha256, archiveSha256: null, expectedSha256, expectedHashVerified: expectedSha256 !== null }
}

export async function auditIbis(out, experimentDir, circuit, run) {
  const assemblies = await json(join(experimentDir, 'native-ibis-assembly.json'))
  const declaredModels = circuit.filter(element => element.type === 'simulation_ibis_model')
  assert.deepEqual(assemblies.map(model => model.simulationIbisModelId).sort(), declaredModels.map(model => model.simulation_ibis_model_id).sort(), 'Each native model attachment is assembled exactly once')
  const states = circuit.filter(element => element.type === 'simulation_ibis_pin_state' && element.simulation_experiment_id === run.simulationExperimentId)
  const stimuli = circuit.filter(element => element.type === 'simulation_digital_stimulus' && element.simulation_experiment_id === run.simulationExperimentId)
  const nodeMap = await json(join(out, 'electrical-node-map.json'))
  const deck = await readFile(join(experimentDir, 'simulation.cir'), 'utf8')
  const declaredDcRailNodes = new Set((await declaredDcSupplies(out,circuit,nodeMap,deck))
    .flatMap(source => [source.positiveNode,source.negativeNode]))
  assert.equal(new Set(states.map(state => state.source_port_id)).size, states.length, 'Unique fixed state for each physical pin')
  assert.equal(new Set(stimuli.map(stimulus => stimulus.source_port_id)).size, stimuli.length, 'No duplicate driver stimulus')
  const evidence = []
  for (const [modelIndex, assembly] of assemblies.entries()) {
    const declared = one(declaredModels, model => model.simulation_ibis_model_id === assembly.simulationIbisModelId, 'Exact native model association')
    const definition = assembly.definition, metadata = assembly.metadata, source = assembly.sourceEvidence
    assert.deepEqual(source.ibisModelAsset, declared.ibis_model_asset, 'Loaded source retains its native asset descriptor')
    assert.equal(definition.component, declared.ibis_component_name)
    assert.deepEqual(definition.pinMap, declared.ibis_pin_name_to_source_port_id, 'Physical IBIS pin maps to the actual local source-port ID')
    assert.deepEqual(definition.modelSelections, declared.ibis_pin_name_to_model_name)
    assert.equal(definition.corner, declared.model_value_corner)
    let packagePolicy = 'omit'
    if (declared.include_package_parasitics) packagePolicy = 'vendor'
    assert.equal(definition.packagePolicy, packagePolicy)
    const references = Object.fromEntries(Object.entries(declared.ibis_pin_name_to_reference_source_port_ids ?? {}).map(([pin, refs]) => [pin, {
      pullup: refs.pullup_reference_source_port_id,
      pulldown: refs.pulldown_reference_source_port_id,
      powerClamp: refs.power_clamp_reference_source_port_id,
      groundClamp: refs.ground_clamp_reference_source_port_id,
      external: refs.external_reference_source_port_id,
    }]))
    assert.deepEqual(definition.references, JSON.parse(JSON.stringify(references)), 'Canonical reference roles reach the converter unchanged')
    const bytes = await readFile(join(out, source.ibsFile))
    const digest = sha256(bytes)
    assert.equal(digest, source.sourceSha256)
    assert.equal(digest, assembly.sourceSha256)
    assert.equal(digest, metadata.sourceSha256)
    assert.deepEqual(definition.source, { file: source.ibsFile, sha256: digest }, 'Converter consumes the captured asset bytes')
    const checksums = await auditIbisSource(out, declared.ibis_model_asset, source, bytes)
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
      const expectedRunState = { mode: 'input' }
      if (state.is_output) {
        expectedRunState.mode = 'output'
        expectedRunState.enabled = state.is_output_enabled
      }
      assert.deepEqual(pin.runState, expectedRunState, 'Canonical booleans reach the converter run state')
      const controls = stimuli.filter(stimulus => stimulus.source_port_id === pin.port)
      const enabled = state.is_output && state.is_output_enabled
      assert.equal(controls.length, enabled ? 1 : 0, 'Enabled output has exactly one explicit control; input/disabled output has none')
      if (pin.enable && state.is_output) assert.equal(pin.enableControlLevel, Number(state.is_output_enabled) ^ Number(pin.enable === 'active-low'), 'Boolean enable intent maps through vendor enable polarity')
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
