import test from 'node:test'
import assert from 'node:assert/strict'
import {measureWaveform,foldProbeEye,foldEye} from '../src/metrics.mjs'
test('clock eye rejects a declared UI that differs from executed edges',()=>{
  const rows=Array.from({length:1001},(_,i)=>{const t=i*1e-10,d=Math.sin(2*Math.PI*t/5e-9),v=Math.sin(2*Math.PI*(t-1e-10)/5e-9);return [t,0,0,0,0,v,d]})
  assert.throws(()=>measureWaveform(rows,{excludeSeconds:2e-8,uiSeconds:3e-9}),/clock_ui/)
  assert.ok(measureWaveform(rows,{excludeSeconds:2e-8,uiSeconds:2.5e-9}).eyeHeightAtCenterV>1.9)
})
test('a partial transient cannot be reported as a completed eye run',()=>{
  const rows=Array.from({length:801},(_,i)=>{const t=i*1e-10,d=Math.sin(2*Math.PI*t/5e-9),v=Math.sin(2*Math.PI*(t-1e-10)/5e-9);return [t,0,0,0,0,v,d]})
  assert.throws(()=>measureWaveform(rows,{excludeSeconds:2e-8,uiSeconds:2.5e-9,durationSeconds:100e-9}),/simulation_duration/)
})

test('eye budgets reject window and sample amplification before interpolation',()=>{
  const rows=[[0,0],[5,1]],eye={name:'bounded',column:1,unitIntervalSeconds:1,timeOriginSeconds:.5,startTimeSeconds:0,endTimeSeconds:5}
  const metrics={uiSeconds:1,eyePhaseSeconds:.5,steadyStateStartSeconds:0}
  for(const fold of [
    (points,limits,ui=1)=>foldProbeEye(rows,{...eye,unitIntervalSeconds:ui},points,limits),
    (points,limits,ui=1)=>foldEye(rows,{...metrics,uiSeconds:ui},{differentialColumn:1,polarity:1},points,limits),
  ]) {
    assert.throws(()=>fold(2,{maxWindows:3}),/eye_budget.*windows/)
    assert.throws(()=>fold(3,{maxSamples:11}),/eye_budget.*samples/)
    assert.throws(()=>fold(1e9),/eye_budget.*samples/)
    assert.throws(()=>fold(2,undefined,1e-8),/eye_budget.*windows/)
    assert.throws(()=>fold(2,undefined,1e-20),/eye_budget/)
    assert.throws(()=>fold(2,{maxSamples:Infinity}),/eye_budget/)
    const result=fold(3,{maxWindows:4,maxSamples:12})
    assert.equal(result.windows,4)
    assert.equal(result.samples.length,12)
  }
})
