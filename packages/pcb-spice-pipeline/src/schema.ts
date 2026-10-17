import { z } from 'zod'
import * as base from 'circuit-json'
import type { CircuitJson as BaseCircuitJson } from 'circuit-json'

// Experimental SI records belong to this adapter until they are upstreamed.
// Ordinary PCB/electrical records continue to use the published schemas.
const id = z.string().min(1)
const hash = z.string().regex(/^[a-f0-9]{64}$/i)
const archive = z.object({ member: id, memberSha256: hash.optional() }).strict()
const source = z.union([
  z.object({ url: z.string().url(), sha256: hash, archive: archive.optional() }).strict(),
  z.object({ file: id, sha256: hash.optional(), archive: archive.optional() }).strict(),
  z.object({ content: id, sha256: hash.optional() }).strict(),
])
export const simulation_ibis_model = z.object({
  type: z.literal('simulation_ibis_model'), simulation_ibis_model_id: id,
  source_component_id: id, source, component: id,
  pin_to_source_port_map: z.record(id, id).refine(pins => Object.keys(pins).length > 0),
  model_selections: z.record(id, id).optional(),
  references: z.record(id, z.object({ pullup: id.optional(), pulldown: id.optional(),
    power_clamp: id.optional(), ground_clamp: id.optional(), external: id.optional() }).strict()).optional(),
  corner: z.enum(['typical', 'minimum', 'maximum']), package_policy: z.enum(['vendor', 'omit']),
}).strict()
export const simulation_ibis_pin_state = z.object({
  type: z.literal('simulation_ibis_pin_state'), simulation_ibis_pin_state_id: id,
  simulation_experiment_id: id, source_port_id: id, mode: z.enum(['input', 'output']), enabled: z.boolean().optional(),
}).strict().superRefine((state, ctx) => {
  if ((state.mode === 'output' && state.enabled === undefined) || (state.mode === 'input' && state.enabled !== undefined))
    ctx.addIssue({ code: 'custom', message: 'Only output states require an explicit enabled boolean' })
})
export const simulation_digital_stimulus = z.object({
  type: z.literal('simulation_digital_stimulus'), simulation_digital_stimulus_id: id,
  name: id, simulation_experiment_id: id, source_port_id: id,
  unit_interval_ms: z.number().finite().positive(), start_time_ms: z.number().finite().nonnegative(),
  initial_state: z.union([z.literal(0), z.literal(1)]), inverted: z.boolean(),
  pattern: z.object({ type: z.literal('bits'), bits: z.string().regex(/^[01]+$/), repeat: z.boolean() }).strict(),
}).strict()
export const simulation_eye_diagram = z.object({
  type: z.literal('simulation_eye_diagram'), simulation_eye_diagram_id: id,
  name: id, simulation_experiment_id: id, simulation_voltage_probe_id: id,
  unit_interval_ms: z.number().finite().positive(), time_origin_ms: z.number().finite(),
  start_time_ms: z.number().finite().nonnegative().optional(), end_time_ms: z.number().finite().positive().optional(),
}).strict().superRefine((eye, ctx) => {
  if (eye.start_time_ms !== undefined && eye.end_time_ms !== undefined && eye.start_time_ms >= eye.end_time_ms)
    ctx.addIssue({ code: 'custom', message: 'Eye gate end must follow start' })
})
const experimentExtras = z.object({ subcircuit_id: id.optional(), spice_engine: id.optional(),
  execution_mode: z.enum(['native', 'external']).optional(),
  execution_status: z.enum(['pending', 'running', 'complete', 'failed']).optional() })
const graphExtras = z.object({ simulation_voltage_probe_id: id.optional() })
// Published core and saved boards use a few newer serialization forms than
// circuit-json@0.0.528. Validate equivalent aliases with the official physical
// schema, while retaining the original record bytes/values in our results.
const compatible = (schema: z.ZodTypeAny, normalize: (record: Record<string, unknown>) => Record<string, unknown>) =>
  z.preprocess(value => [value, value && typeof value === 'object' ? normalize({...value}) : value],
    z.tuple([z.unknown(), schema])).transform(([original]) => original)
export type SimulationIbisModel = z.infer<typeof simulation_ibis_model>
export type SimulationIbisPinState = z.infer<typeof simulation_ibis_pin_state>
export type SimulationDigitalStimulus = z.infer<typeof simulation_digital_stimulus>
export type SimulationExperiment = base.SimulationExperiment & z.infer<typeof experimentExtras>
type Graph = Extract<BaseCircuitJson[number], { type: 'simulation_transient_voltage_graph' }> & z.infer<typeof graphExtras>
type Extension = SimulationIbisModel | SimulationIbisPinState | SimulationDigitalStimulus | z.infer<typeof simulation_eye_diagram>
export type CircuitJson = Array<Exclude<BaseCircuitJson[number], { type: 'simulation_experiment' | 'simulation_transient_voltage_graph' }> | SimulationExperiment | Graph | Extension>

const extensions: Record<string, z.ZodTypeAny> = {
  simulation_ibis_model, simulation_ibis_pin_state, simulation_digital_stimulus, simulation_eye_diagram,
  simulation_experiment: z.intersection(base.simulation_experiment, experimentExtras),
  simulation_transient_voltage_graph: z.intersection(base.simulation_transient_voltage_graph, graphExtras),
  pcb_component: compatible(base.pcb_component, record => {
    for (const key of ['display_offset_x','display_offset_y'])
      if (typeof record[key] === 'number' && Number.isFinite(record[key])) record[key] = `${record[key]}mm`
    return record
  }),
  pcb_silkscreen_text: base.pcb_silkscreen_text.extend({pcb_component_id:z.string().nullable()}),
  pcb_hole: z.union([base.pcb_hole,z.object({type:z.literal('pcb_hole'),pcb_hole_id:id,
    pcb_component_id:z.null(),hole_shape:z.literal('circle'),hole_diameter:z.number().finite().positive(),
    x:z.number().finite(),y:z.number().finite(),subcircuit_id:id.optional(),is_covered_with_solder_mask:z.boolean().optional()}).passthrough()]),
  pcb_plated_hole: compatible(base.pcb_plated_hole, record => record.shape === 'circular_hole_with_rect_pad'
    ? {...record,hole_shape:record.hole_shape??'circle',pad_shape:record.pad_shape??'rect'} : record),
}
export function recordSchema(record: { type: string; ftype?: string }): z.ZodTypeAny | undefined {
  return extensions[record.type] ?? Reflect.get(base, record.type === 'source_component' ? `source_${record.ftype}` : record.type)
}
export function parseRecord(record: unknown): CircuitJson[number] {
  if (!record || typeof record !== 'object' || !('type' in record) || typeof record.type !== 'string') throw new Error('Circuit record requires a type')
  const schema = recordSchema(record as { type: string })
  if (!schema) throw new Error(`Unknown Circuit JSON record: ${record.type}`)
  return schema.parse(record)
}
