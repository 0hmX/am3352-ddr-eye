import { createContext, createElement, useContext, useId, useLayoutEffect } from 'react'
import type { ReactElement } from 'react'
import type { IbisBitsStimulus, IbisModelDefinition, IbisPinRunState, IbisTimeInput } from '@tscircuit/ibis-to-spice'

export type { IbisModelDefinition } from '@tscircuit/ibis-to-spice'
export interface ModelProps extends IbisModelDefinition { componentRef: string }
export interface TransientProps {
  name: string; duration: IbisTimeInput; timePerStep: IbisTimeInput; startTime?: IbisTimeInput
  spiceEngine?: 'ngspice'; ibisPinStates: Record<string, IbisPinRunState>
  spiceOptions?: { method?: 'trap' | 'gear'; reltol?: number | string; abstol?: number | string; vntol?: number | string }
}
export interface StimulusProps extends IbisBitsStimulus { name: string; simulationRef: string; drives: string }
export interface ProbeProps { name: string; connectsTo: string; referenceTo?: string }
export interface EyeProps {
  name: string; simulationRef: string; probeRef: string; unitInterval: IbisTimeInput; timeOrigin: IbisTimeInput
  startTime?: IbisTimeInput; endTime?: IbisTimeInput
}
export type Declaration = { kind: 'Model'; props: ModelProps } | { kind: 'Transient'; props: TransientProps }
  | { kind: 'Stimulus'; props: StimulusProps } | { kind: 'Probe'; props: ProbeProps } | { kind: 'Eye'; props: EyeProps }
  | { kind: 'ImportedBoard'; props: { circuitJson: readonly unknown[] } }
export type Collector = Map<string, Declaration>
// tsx's isolated loader can evaluate this module twice. Share only the Context
// identity; each mounted React tree owns its own collector value.
const key = Symbol.for('pcb-spice-pipeline.react-context.v1')
const contexts = globalThis as typeof globalThis & { [key: symbol]: ReturnType<typeof createContext<Collector | null>> }
const Context = contexts[key] ??= createContext<Collector | null>(null)
function declaration<K extends Declaration['kind']>(kind: K) {
  return function DeclarationComponent(props: Extract<Declaration, { kind: K }>['props']) {
    const collector = useContext(Context), id = useId()
    useLayoutEffect(() => {
      collector?.set(id, { kind, props } as Declaration)
      return () => { collector?.delete(id) }
    }, [collector, id, props])
    return null
  }
}
// Ordinary tscircuit preview renders the board without executing or downloading
// anything. The local runner supplies a collector for these typed declarations.
export const si = {
  Model: declaration('Model'), Transient: declaration('Transient'), Stimulus: declaration('Stimulus'),
  Probe: declaration('Probe'), Eye: declaration('Eye'),
  ImportedBoard: function ImportedBoard(props: { circuitJson: readonly unknown[] }) {
    const collector = useContext(Context), id = useId()
    useLayoutEffect(() => {
      collector?.set(id, { kind: 'ImportedBoard', props })
      return () => { collector?.delete(id) }
    }, [collector, id, props])
    const records = props.circuitJson as Array<{type: string; [key: string]: unknown}>
    const board = records.find(record => record.type === 'pcb_board')
    if (!board) throw new Error('ImportedBoard requires a saved pcb_board record')
    // The published importer cannot inflate every legacy source ftype. For PCB
    // preview only, use generic chips with the saved pads/routes. The runner
    // consumes the exact original records, never these display substitutions.
    const preview = records.filter(record => record.type !== 'schematic_component').map(record => record.type === 'source_component' ? {...record,ftype:'simple_chip'} : record)
    if (!collector) for (const component of records.filter(record=>record.type==='source_component')) {
      const ports=records.filter(record=>record.type==='source_port'&&record.source_component_id===component.source_component_id)
      const labels=Object.fromEntries(ports.map((port,index)=>[`pin${port.pin_number??index+1}`,
        [...new Set([port.name,...(Array.isArray(port.port_hints)?port.port_hints:[])].filter((value):value is string=>typeof value==='string'&&value.length>0))]]))
      preview.push({type:'schematic_component',schematic_component_id:`preview_${component.source_component_id}`,
        source_component_id:component.source_component_id,port_labels:labels})
    }
    return createElement('board', { width: board.width, height: board.height, thickness: board.thickness,
      layers: board.num_layers, routingDisabled: true, schematicDisabled: true, placementDrcChecksDisabled: true,
      ...(collector ? {} : { circuitJson: preview }) })
  },
}
export const collectSimulation = (element: ReactElement, collector: Collector) =>
  createElement(Context.Provider, { value: collector }, element)
