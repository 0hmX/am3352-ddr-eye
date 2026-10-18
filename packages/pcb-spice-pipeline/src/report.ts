import type { CircuitJson, SimulationIbisPinState } from './schema.js'
import type { Geometry, Modeling } from './geometry.js'
import { selectPort } from './geometry.js'
import type { SimulationPlan } from './declarations.js'

export type ReportTest = Pick<SimulationPlan, 'startTimeSeconds' | 'durationSeconds' | 'maxStepSeconds' | 'stimuli' | 'states' | 'models'>
export interface ReportContext {
  description?: string
  ports: Record<string, string>
  lanes: Array<{ name: string; from: string; to: string; sourceTraceId: string; pcbTraceId: string;
    lengthMm: number; layers: string[]; widthsMm: number[]; vias: number; route: Array<{ x: number; y: number }> }>
  settings: Array<[string, string]>
  board?: {
    bounds: { minX: number; maxX: number; minY: number; maxY: number }
    outlines: Array<{ x: number; y: number; width: number; height: number }>
    outlinePaths: string[]
    traces: Array<{ id: string; path: string }>
    components: Array<{ id: string; name: string; x: number; y: number; width: number; height: number; used: boolean }>
  }
}
export interface ReportProbe {
  name: string; column: number; simulationVoltageProbeId?: string
  signalSourceId?: string; referenceSourceId?: string | null
  signalLabel?: string; referenceLabel?: string
}
export interface ReportEye {
  name: string; simulationVoltageProbeId?: string; unitIntervalSeconds: number
  startTimeSeconds?: number; endTimeSeconds?: number; timeOriginSeconds?: number
  windows?: number; windowOriginsSeconds?: number[]; csv?: string
  metrics?: { voltageRangeV: number[] }
}
export interface ReportRun {
  name: string; rows: number[][]; probes: ReportProbe[]; eyes: ReportEye[]; test?: ReportTest
}
export interface ReportChange {
  quiet: string; active: string; peakAbsoluteV: number; timeRmsV: number; startSeconds: number; endSeconds: number
}
export interface ReportData {
  runs: ReportRun[]; limitations: string[]; context?: ReportContext; changes?: ReportChange[]; comparisonProbeName?: string
}
export interface ReportFile { path: string; label: string; description: string; content: string }

export const html = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
export const number = (value: number | undefined, unit = '', scale = 1) => value === undefined ? 'Not recorded' : `${Number((value * scale).toPrecision(6))}${unit ? ` ${unit}` : ''}`
const csv = (rows: unknown[][]) => rows.map(row => row.map(value => typeof value === 'number' ? String(value) : `"${String(value ?? '').replace(/"/g, '""')}"`).join(',')).join('\n') + '\n'
const table = (heads: string[], rows: unknown[][]) => `<div class="table-scroll"><table><thead><tr>${heads.map(h => `<th>${html(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${html(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
const label = (context: Pick<ReportContext, 'ports'> | undefined, id: string | null | undefined) => id ? context?.ports[id] ?? id : 'Channel ground'
const probeLabels = (probe: ReportProbe, context?: ReportContext) => [probe.signalLabel ?? (probe.signalSourceId ? label(context, probe.signalSourceId) : 'Recorded signal'), probe.referenceLabel ?? label(context, probe.referenceSourceId)]
const tracePath = (points: Array<{ x?: number; y?: number; start?: { x: number; y: number }; end?: { x: number; y: number } }>) => {
  let connected = false
  return points.map(point => {
    if (point.start && point.end) { connected = true; return `M${point.start.x},${-point.start.y} L${point.end.x},${-point.end.y}` }
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) { connected = false; return '' }
    const command = connected ? 'L' : 'M'; connected = true
    return `${command}${point.x},${-point.y!}`
  }).join(' ')
}

export function reportContext(circuit: CircuitJson, geometry: Geometry, modeling: Modeling): ReportContext {
  const ports: Record<string, string> = {}
  const components = new Map(circuit.filter(e => e.type === 'source_component').map(e => [e.source_component_id, e]))
  for (const port of circuit.filter(e => e.type === 'source_port')) {
    const component = components.get(port.source_component_id ?? '')
    ports[port.source_port_id] = `${component?.name ?? port.source_component_id}.${port.name ?? `pin${port.pin_number}`}`
  }
  const counts = new Map<string, number>()
  for (const value of Object.values(ports)) counts.set(value, (counts.get(value) ?? 0) + 1)
  for (const [id, value] of Object.entries(ports)) if (counts.get(value)! > 1) ports[id] = `${value} (${id})`
  for (const net of circuit.filter(e => e.type === 'source_net')) ports[net.source_net_id] = net.name
  const sourcePorts = new Map(circuit.filter(e => e.type === 'source_port').map(port => [port.source_port_id, port]))
  const used = new Set<string>()
  const usePort = (id?: string) => { const component = sourcePorts.get(id ?? '')?.source_component_id; if (component) used.add(component) }
  for (const lane of geometry.mappings) { usePort(lane.from); usePort(lane.to) }
  for (const selection of modeling.passiveComponents ?? []) for (const [id, component] of components)
    if (selection.sourceComponentId ? selection.sourceComponentId === id : selection.component === component.name) used.add(id)
  for (const source of circuit.filter(e => e.type === 'simulation_voltage_source')) for (const id of source.is_dc_source
    ? [source.positive_source_port_id, source.negative_source_port_id] : [source.terminal1_source_port_id, source.terminal2_source_port_id]) usePort(id)
  for (const supply of modeling.supplies ?? []) { usePort(selectPort(circuit, supply.positive).source_port_id); usePort(selectPort(circuit, supply.negative).source_port_id) }
  const boardComponents = circuit.filter(e => e.type === 'pcb_component').filter(e => e.do_not_place !== true).map(component => ({
    id: component.pcb_component_id, name: components.get(component.source_component_id)?.name ?? component.pcb_component_id,
    x: component.center.x, y: component.center.y, width: component.width, height: component.height, used: used.has(component.source_component_id),
  }))
  const outlines = circuit.filter(e => e.type === 'pcb_board').flatMap(board => !board.outline?.length && board.width !== undefined && board.height !== undefined
    ? [{ x: board.center.x, y: board.center.y, width: board.width, height: board.height }] : [])
  const outlinePoints = circuit.filter(e => e.type === 'pcb_board').flatMap(board => board.outline ?? [])
  const outlinePaths = circuit.filter(e => e.type === 'pcb_board').flatMap(board => board.outline?.length ? [tracePath(board.outline) + ' Z'] : [])
  const allPoints = circuit.filter(e => e.type === 'pcb_trace').flatMap(trace => trace.route).flatMap(point => point.route_type === 'through_pad' ? [point.start, point.end] : [{ x: point.x, y: point.y }])
  allPoints.push(...outlinePoints)
  for (const box of [...boardComponents, ...outlines]) for (const sign of [-1, 1]) allPoints.push({ x: box.x + sign * box.width / 2, y: box.y + sign * box.height / 2 })
  const bounds = allPoints.reduce((b, point) => ({ minX: Math.min(b.minX, point.x), maxX: Math.max(b.maxX, point.x), minY: Math.min(b.minY, point.y), maxY: Math.max(b.maxY, point.y) }),
    { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity })
  return { description: modeling.description, ports,
    board: allPoints.length ? { bounds, outlines, outlinePaths, components: boardComponents,
      traces: circuit.filter(e => e.type === 'pcb_trace').map(trace => ({ id: trace.pcb_trace_id, path: tracePath(trace.route) })) } : undefined,
    lanes: geometry.mappings.map(lane => ({ name: lane.port, from: lane.from, to: lane.to,
      sourceTraceId: lane.sourceTraceId, pcbTraceId: lane.pcbTraceId,
      lengthMm: lane.stages.reduce((sum, stage) => sum + stage.lengthMm, 0),
      layers: lane.stages.map(stage => stage.profile), widthsMm: [...new Set(lane.stages.filter(stage => stage.kind === 'wire').map(stage => stage.widthMm))],
      vias: lane.stages.filter(stage => stage.kind === 'via').length, route: lane.originalRoute.map(({ x, y }) => ({ x, y })) })),
    settings: [
      ['Channel model', 'Straightened stages from selected routed traces, with full mutual R/L/C coupling and an explicit finite return conductor'],
      ['R/L model frequency', number(modeling.extraction.modelHz, 'MHz', 1e-6)],
      ['Extraction frequency range', `${number(modeling.extraction.minimumHz, 'Hz')} to ${number(modeling.extraction.maximumHz, 'MHz', 1e-6)}`],
      ['Lumped sections per stage', String(modeling.sections)],
      ['Conductivity', number(modeling.conductivitySm, 'S/m')],
      ...(modeling.supplies ?? []).map((s, i): [string, string] => [`Declared supply ${i + 1}`,
        `${number(s.voltageV, 'V DC')}; ${ports[selectPort(circuit, s.positive).source_port_id]} − ${ports[selectPort(circuit, s.negative).source_port_id]}`]),
      ...circuit.filter(e => e.type === 'simulation_voltage_source').map((s): [string, string] => ['Physical voltage source',
        `${number(s.voltage, 'V')} ${s.is_dc_source || !s.wave_shape ? 'DC' : s.wave_shape}; ${label({ ports }, s.is_dc_source ? s.positive_source_port_id ?? s.positive_source_net_id : s.terminal1_source_port_id)} − ${label({ ports }, s.is_dc_source ? s.negative_source_port_id ?? s.negative_source_net_id : s.terminal2_source_port_id)}`]),
      ...Object.entries(modeling.profiles).map(([name, profile]): [string, string] => [name + ' material / return',
        `Signal center spacing ${number(profile.spacingMm, 'mm')}; relative permittivity ${number(profile.relativePermittivity)}; return width ${number(profile.return.widthMm, 'mm')}, thickness ${number(profile.return.thicknessMm, 'mm')}, center y/z ${number(profile.return.centerYMm, 'mm')} / ${number(profile.return.centerZMm, 'mm')}, length factor ${profile.return.lengthFactor}`]),
    ],
  }
}

export function reportFiles(data: ReportData): ReportFile[] {
  const files: ReportFile[] = [], summaries: unknown[][] = [], probes: unknown[][] = [], tests: unknown[][] = [], eyes: unknown[][] = []
  const add = (path: string, label: string, description: string, content: string) => files.push({ path: 'csv/' + path, label, description, content })
  data.runs.forEach((run, i) => {
    const prefix = `${String(i + 1).padStart(2, '0')}-${run.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 64) || 'experiment'}`
    add(`${prefix}-waveforms.csv`, `${run.name} · full waveforms`, `${run.rows.length.toLocaleString('en-US')} recorded adaptive timestamps; time in seconds, voltage in volts.`,
      csv([['time_s', ...run.probes.map(p => p.name + '_v')], ...run.rows.map(row => [row[0], ...run.probes.map(p => row[p.column])])]))
    for (const probe of run.probes) {
      let minimum = Infinity, maximum = -Infinity
      for (const row of run.rows) { minimum = Math.min(minimum, row[probe.column]); maximum = Math.max(maximum, row[probe.column]) }
      summaries.push([i + 1, run.name, probe.name, ...probeLabels(probe, data.context), run.rows.length, run.rows[0][0], run.rows.at(-1)![0], minimum, maximum])
      probes.push([run.name, probe.name, probe.name + '_v', ...probeLabels(probe, data.context), probe.signalSourceId, probe.referenceSourceId, probe.simulationVoltageProbeId])
    }
    for (const stimulus of run.test?.stimuli ?? []) tests.push([i + 1, run.name, label(data.context, stimulus.source_port_id),
      stimulus.pattern.bits, stimulus.pattern.repeat, Boolean(stimulus.inverted), stimulus.initial_state,
      stimulus.unit_interval_ms / 1000, stimulus.start_time_ms / 1000, run.test!.startTimeSeconds, run.test!.durationSeconds, run.test!.maxStepSeconds])
    run.eyes.forEach((eye, index) => {
      eyes.push([run.name, eye.name, run.probes.find(p => p.simulationVoltageProbeId === eye.simulationVoltageProbeId)?.name,
        eye.startTimeSeconds, eye.endTimeSeconds, eye.unitIntervalSeconds, eye.timeOriginSeconds, eye.windows ?? eye.windowOriginsSeconds?.length,
        eye.metrics?.voltageRangeV[0], eye.metrics?.voltageRangeV[1]])
      if (eye.csv !== undefined) add(`${prefix}-eye-${index + 1}.csv`, `${run.name} · ${eye.name}`, 'Complete folded eye samples, linearly interpolated from recorded waveforms; both original and folded time in seconds.', eye.csv)
    })
  })
  const overview: ReportFile[] = []
  const summary = (path: string, label: string, description: string, rows: unknown[][]) => overview.push({ path: 'csv/' + path, label, description, content: csv(rows) })
  summary('results-summary.csv', 'Results summary', 'One row per experiment and measured probe; voltage extrema over the full recorded time range.',
    [['order', 'experiment', 'probe', 'signal', 'reference', 'samples', 'start_s', 'end_s', 'minimum_v', 'maximum_v'], ...summaries])
  summary('probe-map.csv', 'Probe and column map', 'What each voltage column measures: signal minus reference.',
    [['experiment', 'probe', 'csv_column', 'signal', 'reference', 'signal_source_id', 'reference_source_id', 'probe_id'], ...probes])
  if (data.context) summary('trace-map.csv', 'Selected trace map', 'Physical endpoints, original trace IDs, total modeled path length including via barrels, wire widths and ordered stages.',
    [['trace', 'driver', 'receiver', 'source_trace_id', 'pcb_trace_id', 'length_mm', 'wire_widths_mm', 'stage_order', 'vias'],
      ...data.context.lanes.map(lane => [lane.name, label(data.context, lane.from), label(data.context, lane.to), lane.sourceTraceId, lane.pcbTraceId, lane.lengthMm, lane.widthsMm.join(' / '), lane.layers.join(' > '), lane.vias])])
  if (tests.length) summary('test-plan.csv', 'Experiment and stimulus plan', 'Declared bits before optional inversion; one row per driven signal. Timing units are seconds.',
    [['order', 'experiment', 'drives', 'bits', 'repeat', 'inverted', 'initial_state_before_inversion', 'unit_interval_s', 'stimulus_start_s', 'recording_start_s', 'simulation_end_s', 'maximum_step_s'], ...tests])
  if (eyes.length) summary('eye-summary.csv', 'Eye measurement summary', 'Declared measurement gates, folding origins and finite observed voltage ranges. No eye opening or compliance estimate.',
    [['experiment', 'eye', 'probe', 'gate_start_s', 'gate_end_s', 'unit_interval_s', 'origin_s', 'complete_windows', 'minimum_v', 'maximum_v'], ...eyes])
  if (data.changes?.length) summary('comparison.csv', 'Quiet versus switching measurements', 'Switching minus quiet; extrema of piecewise-linear recorded data, with RMS integrated over the stated gate.',
    [['probe', 'quiet', 'switching', 'gate_start_s', 'gate_end_s', 'peak_absolute_difference_v', 'time_rms_difference_v'],
      ...data.changes.map(c => [data.comparisonProbeName, c.quiet, c.active, c.startSeconds, c.endSeconds, c.peakAbsoluteV, c.timeRmsV])])
  return [...overview, ...files]
}

function routeDrawing(context: ReportContext): string {
  const points = context.lanes.flatMap(lane => lane.route)
  if (!points.length) return ''
  const colors = ['#2563eb', '#e96535', '#159c80'], board = context.board
  const boxes = board?.components.filter(component => component.used) ?? []
  const selectedBounds = points.reduce((b, p) => ({ minX: Math.min(b.minX, p.x), maxX: Math.max(b.maxX, p.x), minY: Math.min(b.minY, p.y), maxY: Math.max(b.maxY, p.y) }),
    { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity })
  const full = board?.bounds ?? selectedBounds
  const view = (bounds: typeof selectedBounds) => { const margin = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, 1) * .06 + .5
    return `${bounds.minX - margin} ${-bounds.maxY - margin} ${bounds.maxX - bounds.minX + 2 * margin} ${bounds.maxY - bounds.minY + 2 * margin}` }
  const selectedIds = new Set(context.lanes.map(lane => lane.pcbTraceId)), fontSize = Math.max((full.maxX - full.minX) / 75, .5)
  const rect = (box: { x: number; y: number; width: number; height: number }) => `x="${box.x - box.width / 2}" y="${-box.y - box.height / 2}" width="${box.width}" height="${box.height}"`
  return `<div class="route-map"><div class="board-toolbar">${board?.traces.length ?? context.lanes.length} traces · ${board?.components.length ?? 0} components · all copper layers</div><svg id="board-diagram" viewBox="${view(full)}" role="img" aria-label="Board overview: unused traces and component bounds in gray; simulated traces and components highlighted">
    <g class="board-outline">${board?.outlines.map(box => `<rect ${rect(box)}/>`).join('') ?? ''}${board?.outlinePaths.map(path => `<path d="${path}"/>`).join('') ?? ''}</g>
    <g class="unused-components">${board?.components.filter(component => !component.used).map(component => `<rect ${rect(component)} data-component="${html(component.id)}"><title>${html(component.name)} · outside this simulation</title></rect>`).join('') ?? ''}</g>
    <g class="unused-traces">${board?.traces.filter(trace => !selectedIds.has(trace.id)).map(trace => `<path d="${trace.path}" data-trace="${html(trace.id)}"><title>${html(trace.id)} · outside this simulation</title></path>`).join('') ?? ''}</g>
    <g class="used-components">${boxes.map(component => `<rect ${rect(component)} data-component="${html(component.id)}"><title>${html(component.name)} · used by this simulation</title></rect>`).join('')}</g>
    <g class="used-traces">${context.lanes.map((lane, i) => `<g stroke="${colors[i % colors.length]}"><path d="${tracePath(lane.route)}" data-trace="${html(lane.pcbTraceId)}"><title>${html(lane.name)}: ${html(label(context, lane.from))} → ${html(label(context, lane.to))}</title></path>${[lane.route[0], lane.route.at(-1)!].map((p, endpoint) => `<circle cx="${p.x}" cy="${-p.y}" r=".22" fill="${endpoint ? colors[i % colors.length] : '#fff'}"><title>${endpoint ? 'Receiver' : 'Driver'}: ${html(label(context, endpoint ? lane.to : lane.from))}</title></circle>`).join('')}</g>`).join('')}</g>
    <g class="component-labels" font-size="${fontSize}">${boxes.map(box => `<text x="${box.x}" y="${-box.y + fontSize / 3}">${html(box.name)}</text>`).join('')}</g>
    </svg><div class="board-legend">${context.lanes.map((lane, i) => `<span style="color:${colors[i % colors.length]}">● ${html(lane.name)}</span>`).join('')}<span class="component-key">▣ Simulated components</span><span class="unused-key">— Context only</span></div><p class="hint">Top view · component bounds · gray geometry is outside this simulation.</p></div>`
}

function bufferState(state: SimulationIbisPinState): string[] {
  if(state.is_output) return ['output',String(state.is_output_enabled)]
  return ['input','—']
}

export function reportSections(data: ReportData, files: ReportFile[]) {
  const context = data.context, observed = new Set(data.runs.flatMap(run => run.probes.filter(p => p.name === data.comparisonProbeName).map(p => p.signalSourceId)))
  const traces = context ? `<div class="board-layout">${routeDrawing(context)}<aside class="trace-inspector"><h2>Selected network</h2>${context.lanes.map((lane, i) => `<div class="trace-row"><h3><span style="color:${['#2563eb', '#e96535', '#159c80'][i % 3]}">●</span> ${html(lane.name)} <small>${data.changes?.length && observed.size ? observed.has(lane.to) ? 'Victim' : 'Neighbor' : ''}</small></h3><div class="pin-pair">${html(label(context, lane.from))} → ${html(label(context, lane.to))}</div><dl><dt>Path length</dt><dd>${number(lane.lengthMm, 'mm')}</dd><dt>Wire width</dt><dd>${lane.widthsMm.map(v => number(v, 'mm')).join(' / ')}</dd><dt>Vias</dt><dd>${lane.vias}</dd></dl><div class="hint">${html(lane.layers.join(' → '))}</div></div>`).join('')}<details><summary>Trace IDs</summary>${table(['Trace', 'Source / PCB ID'], context.lanes.map(lane => [lane.name, `${lane.sourceTraceId} / ${lane.pcbTraceId}`]))}</details></aside></div>` : '<p>Trace geometry unavailable.</p>'
  const plan = data.runs.map(run => `<article class="test-card"><h2>${html(run.name)}</h2>${run.test ? `<p class="hint">${number(run.test.startTimeSeconds, 'ns', 1e9)}–${number(run.test.durationSeconds, 'ns', 1e9)} · max step ${number(run.test.maxStepSeconds, 'ps', 1e12)} · ${run.rows.length.toLocaleString('en-US')} samples</p>${table(['Trace / driver', 'Drive bits', 'Schedule', 'Initial bit'], run.test.stimuli.map(s => [
    `${context?.lanes.find(lane => lane.from === s.source_port_id)?.name ?? 'Signal'} · ${label(context, s.source_port_id)}`,
    s.inverted ? s.pattern.bits.replace(/[01]/g, bit => bit === '0' ? '1' : '0') : s.pattern.bits,
    `${s.pattern.repeat ? 'Repeat' : 'Once'}; UI ${number(s.unit_interval_ms, 'ns', 1e6)}; starts ${number(s.start_time_ms, 'ns', 1e6)}`,
    s.initial_state ^ Number(s.inverted ?? false)]))}${run.test.states?.length ? `<details><summary>Buffer states</summary>${table(['Pin', 'Mode', 'Enabled'], run.test.states.map(state => [label(context, state.source_port_id), ...bufferState(state)]))}</details>` : ''}` : '<p>Settings unavailable.</p>'}</article>`).join('')
  const findings = data.runs.map((run, i) => `<article class="result-card"><div class="result-heading"><h2>${html(run.name)}</h2><button data-run="${i}" data-probe="${Math.max(0, run.probes.findIndex(p => p.name === data.comparisonProbeName))}" data-mode="waveform">Open waveforms</button></div>${table(['Probe', 'Signal − reference', 'Minimum', 'Maximum'], run.probes.map(probe => {
    let minimum = Infinity, maximum = -Infinity
    for (const row of run.rows) { minimum = Math.min(minimum, row[probe.column]); maximum = Math.max(maximum, row[probe.column]) }
    return [probe.name, probeLabels(probe, context).join(' − '), number(minimum, 'V'), number(maximum, 'V')]
  }))}${run.eyes.length ? table(['Eye / probe', 'Gate', 'UI / origin', 'Windows', 'Voltage range'], run.eyes.map(eye => [
    `${eye.name} / ${run.probes.find(p => p.simulationVoltageProbeId === eye.simulationVoltageProbeId)?.name ?? 'recorded probe'}`,
    `${number(eye.startTimeSeconds, 'ns', 1e9)} to ${number(eye.endTimeSeconds, 'ns', 1e9)}`,
    `${number(eye.unitIntervalSeconds, 'ns', 1e9)} / ${number(eye.timeOriginSeconds, 'ns', 1e9)}`,
    eye.windows ?? eye.windowOriginsSeconds?.length ?? 'Not recorded', eye.metrics ? eye.metrics.voltageRangeV.map(v => number(v, 'V')).join(' to ') : 'Not recorded',
  ])) : ''}</article>`).join('')
  const changes = data.changes?.length ? `<div class="comparison-summary"><h2>Neighbor switching · ${html(data.comparisonProbeName ?? 'Selected probe')}</h2>${table(['Switching − quiet', 'Gate', 'Peak absolute ΔV', 'Time RMS ΔV'], data.changes.map(c => [
    `${c.active} − ${c.quiet}`, `${number(c.startSeconds, 'ns', 1e9)} to ${number(c.endSeconds, 'ns', 1e9)}`, number(c.peakAbsoluteV, 'mV', 1000), number(c.timeRmsV, 'mV', 1000),
  ]))}</div>` : ''
  const models = data.runs.map(run => run.test?.models ?? []).flat().filter((model, i, all) => all.findIndex(m => m.pipelineId === model.pipelineId) === i)
  const settings = context ? `<details><summary>Electrical model and extraction settings</summary>${table(['Setting', 'Value'], context.settings)}${models.length ? table(['IBIS device', 'Selected buffers', 'Corner / package parasitics', 'Model asset'], models.map(model => [
    model.ibis_component_name, Object.entries(model.ibis_pin_name_to_model_name ?? {}).map(([pin, buffer]) => `${pin}: ${buffer}`).join('; '), `${model.model_value_corner} / ${String(model.include_package_parasitics)}`, model.ibis_model_asset.project_relative_path,
  ])) : ''}</details>` : ''
  return { traces, plan, findings: changes + findings, settings,
    downloads: `<p class="hint">Time: seconds · voltage: volts. Keep the csv folder beside results.html.</p><div class="table-scroll"><table><thead><tr><th>File</th><th>Data</th><th>Size</th></tr></thead><tbody>${files.map(file => `<tr><td><a href="${html(file.path)}" download title="${html(file.description)}">${html(file.path.slice(4))}</a></td><td>${html(file.label)}</td><td>${number(Buffer.byteLength(file.content) / 1024, 'KB')}</td></tr>`).join('')}</tbody></table></div>` }
}
