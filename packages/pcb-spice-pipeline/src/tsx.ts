import type { Board, Group } from '@tscircuit/core'
import { createElement, Fragment, useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'

export type { IbisModelDefinition } from '@tscircuit/props'
export interface SavedRecord { type: string; [key: string]: unknown }
export const importedBoardRecords = Symbol.for('pcb-spice-pipeline.imported-board.v2')
export const importedBoardDeclarations = Symbol.for('pcb-spice-pipeline.imported-board-declarations.v2')
export type ImportedBoardInstance = Board & { [importedBoardRecords]?: SavedRecord[]; [importedBoardDeclarations]?: Group }

export function savedRecords(circuitJson: readonly unknown[]): SavedRecord[] {
  return circuitJson.map(record => {
    if (!record || typeof record !== 'object' || !('type' in record) || typeof record.type !== 'string')
      throw new Error('ImportedBoard requires Circuit JSON records')
    return record as SavedRecord
  })
}

/** Preserves a routed board while core renders native simulation declarations. */
export function ImportedBoard({ circuitJson, children }: { circuitJson: readonly unknown[]; children?: ReactNode }) {
  const boardRef = useRef<ImportedBoardInstance | null>(null)
  const declarationsRef = useRef<Group | null>(null)
  const records = savedRecords(circuitJson)
  if (records.some(record => record.type.startsWith('simulation_') && record.type !== 'simulation_voltage_source' && record.type !== 'simulation_current_source'))
    throw new Error('ImportedBoard requires a physical saved board without existing simulation declarations or results; export circuitJson directly to run existing declarations')
  for (const port of records.filter(record => record.type === 'source_port' && !record.source_component_id)) {
    const group = records.find(record => record.type === 'source_group' && record.source_group_id === port.source_group_id)
    if (port.source_component_id !== null || (group && group.parent_source_group_id))
      throw new Error(`ImportedBoard cannot recover the owner of saved group pin ${port.name}; use ordinary TSX or export circuitJson directly`)
  }
  const board = records.find(record => record.type === 'pcb_board')
  if (!board) throw new Error('ImportedBoard requires a saved pcb_board record')
  // Legacy component types are displayed as chips; simulation always receives
  // the original saved records, including every route, pad and component type.
  const preview = records.filter(record => record.type !== 'schematic_component').map(record => {
    if (record.type === 'source_component') return { ...record, ftype: 'simple_chip' }
    return record
  })
  for (const component of records.filter(record => record.type === 'source_component')) {
    const ports = records.filter(record => record.type === 'source_port' && record.source_component_id === component.source_component_id)
    const labels = Object.fromEntries(ports.map((port, index) => {
      let pinNumber = port.pin_number
      if (pinNumber === undefined) pinNumber = index + 1
      let aliases: unknown[] = []
      if (Array.isArray(port.port_hints)) aliases = port.port_hints
      return [`pin${pinNumber}`, [...new Set([port.name, ...aliases].filter((value): value is string => typeof value === 'string' && value.length > 0))]]
    }))
    preview.push({ type: 'schematic_component', schematic_component_id: `preview_${component.source_component_id}`,
      source_component_id: component.source_component_id, port_labels: labels })
  }
  useLayoutEffect(() => {
    const instance = boardRef.current
    if (!instance) throw new Error('ImportedBoard native board was not mounted')
    instance[importedBoardRecords] = records
    const group = declarationsRef.current
    if (!group) return
    instance[importedBoardDeclarations] = group
    // The saved-board importer requires circuitJson without JSX children. Move
    // the native declaration group into the board before core render phases.
    instance.add(group)
    return () => { instance.remove(group) }
  }, [circuitJson, children])
  return createElement(Fragment, null,
    createElement('board', { ref: boardRef, width: board.width, height: board.height, thickness: board.thickness,
      layers: board.num_layers, routingDisabled: true, schematicDisabled: true, placementDrcChecksDisabled: true,
      circuitJson: preview }),
    createElement('group', { ref: declarationsRef, name: '__simulation_declarations' }, children))
}
