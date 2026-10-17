import {recordSchema} from './schema.js'
import {fail} from './matrices.mjs'

// Select the registered record schema directly, avoiding a union diagnostic
// containing hundreds of unrelated alternatives. Validation never edits input.
export function validateCircuitRecords(records) {
  if(!Array.isArray(records)) fail('circuit_schema','Expected a Circuit JSON record array')
  for(const record of records) {
    const type=record?.type,id=record?.[`${type}_id`]??record?.name??'(unnamed)'
    const schema=typeof type==='string'?recordSchema(record):undefined
    if(!schema?.safeParse) fail('circuit_schema',`${type??'(missing type)'} ${id}: no registered record schema`)
    const parsed=schema.safeParse(record)
    if(!parsed.success) {
      const issue=parsed.error.issues[0],path=issue.path?.join('.')
      fail('circuit_schema',`${type} ${id}: ${path?path+': ':''}${issue.message}`)
    }
  }
}
