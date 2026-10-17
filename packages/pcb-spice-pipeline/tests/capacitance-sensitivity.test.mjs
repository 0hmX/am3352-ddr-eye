import test from 'node:test'
import assert from 'node:assert/strict'
import {compareCapacitanceWaveforms,runCapacitanceSensitivity} from '../src/capacitance-sensitivity.mjs'

const input={referenceRows:[[0,0,0],[1,1,0],[2,0,0]],candidateRows:[[0,0,0],[.5,0,.25],[1.5,0,.25],[2,0,0]],probes:[{name:'victim'},{name:'reference'}],startSeconds:0,endSeconds:2,maximumWaveformDifferenceV:1}

test('capacitance sensitivity checks extrema on both adaptive grids, including a knot absent from the candidate grid',()=>{
  const result=compareCapacitanceWaveforms(input)
  assert.equal(result.passed,true)
  assert.equal(result.unionTimestamps,5)
  assert.equal(result.probes[0].maximumDifferenceV,1)
  assert.equal(result.probes[0].timeSeconds,1)
  assert.equal(result.probes[0].signedDifferenceV,-1)
  assert.equal(result.probes[1].maximumDifferenceV,.25)
  assert.equal(result.probes[1].timeSeconds,.5)
  assert.equal(compareCapacitanceWaveforms({...input,maximumWaveformDifferenceV:.999}).passed,false)
})

test('sensitivity comparison rejects missing duration, extrapolation, duplicate timestamps and nonfinite samples',()=>{
  for(const candidateRows of [[[.1,0,0],[2,0,0]],[[0,0,0],[1.9,0,0]],[[0,0,0],[0,1,1],[2,0,0]],[[0,0,0],[1,NaN,0],[2,0,0]],[[0,0],[2,0]]]) assert.throws(()=>compareCapacitanceWaveforms({...input,candidateRows}),/capacitance_sensitivity/)
})

test('an uncorrected extraction needs no diagnostic solver invocation',async()=>{
  assert.equal(await runCapacitanceSensitivity({extracted:[{C:[[1]]}]}),null)
})
