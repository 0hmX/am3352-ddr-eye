import { fail } from './matrices.mjs'

// Only timing comes from the element. Board construction and buffer stimulus stay explicit.
export function eyeSimulation(modeling, declarations = []) {
  if (!Array.isArray(declarations) || declarations.length > 1)
    fail('eyediagram', 'This two-lane workflow supports exactly one eyediagram per run')
  if (!declarations.length) {
    if (modeling.requireNativeEye) fail('eyediagram', 'Expected a native <eyediagram> in the rendered TSX board')
    return modeling
  }
  const eye = declarations[0]
  for (const key of ['unitIntervalSeconds', 'durationSeconds', 'timeStepSeconds'])
    if (!Number.isFinite(eye[key]) || eye[key] <= 0) fail('eyediagram', `${eye.name}: ${key} must be positive seconds`)
  if (!Number.isFinite(eye.startTimeSeconds) || eye.startTimeSeconds < 0 || eye.startTimeSeconds >= eye.durationSeconds)
    fail('eyediagram', `${eye.name}: startTime must be nonnegative and before duration`)
  if (eye.timeStepSeconds >= eye.unitIntervalSeconds / 20)
    fail('eyediagram', `${eye.name}: timeStep must resolve a UI by more than 20 samples`)
  return {...modeling, simulation: {...modeling.simulation,
    uiSeconds: eye.unitIntervalSeconds, durationSeconds: eye.durationSeconds,
    stepSeconds: eye.timeStepSeconds, excludeSeconds: eye.startTimeSeconds}}
}

export function resolveEyeDiagram(geometry, modeling, declarations = []) {
  const declaration = declarations[0] ?? {
    name: 'receiver-clock', positiveSourcePortId: geometry.mappings[0].to,
    negativeSourcePortId: geometry.mappings[1].to,
    unitIntervalSeconds: modeling.simulation.uiSeconds,
    durationSeconds: modeling.simulation.durationSeconds,
    timeStepSeconds: modeling.simulation.stepSeconds,
    startTimeSeconds: modeling.simulation.excludeSeconds,
  }
  if (!declaration.name) fail('eyediagram', 'Eye name is required')
  const ids = [declaration.positiveSourcePortId, declaration.negativeSourcePortId]
  if (!ids.every(id => typeof id === 'string') || ids[0] === ids[1])
    fail('eyediagram', `${declaration.name}: positive and negative must resolve to distinct source ports`)
  for (const [endpoint, key, columns, differentialColumn] of [
    ['receiver', 'to', [3, 4], 5], ['driver', 'from', [1, 2], 6],
  ]) {
    const expected = geometry.mappings.map(mapping => mapping[key])
    if (ids.every(id => expected.includes(id))) {
      const lanes = ids.map(id => expected.indexOf(id))
      return {...declaration, origin: declarations.length ? 'native-tsx-element' : 'legacy-modeling',
        endpoint, polarity: lanes[0] === 0 ? 1 : -1,
        positiveColumn: columns[lanes[0]], negativeColumn: columns[lanes[1]],
        differentialColumn, spiceNodes: lanes.map(lane => `${endpoint === 'receiver' ? 'rx' : 'drv'}${lane}`),
        voltageDefinition: 'positive pad voltage minus negative pad voltage'}
    }
  }
  const selectors=[declaration.positiveSelector??ids[0],declaration.negativeSelector??ids[1]]
  fail('eyediagram', `${declaration.name}: probes ${selectors.join(', ')} must be the two extracted receiver ports or the two extracted driver ports; mixed endpoints and unrelated nets are unsupported`)
}
