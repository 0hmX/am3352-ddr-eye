import test from 'node:test'
import assert from 'node:assert/strict'
import {measureWaveform} from '../src/metrics.mjs'
test('clock eye rejects a declared UI that differs from executed edges',()=>{
  const rows=Array.from({length:1001},(_,i)=>{const t=i*1e-10,d=Math.sin(2*Math.PI*t/5e-9),v=Math.sin(2*Math.PI*(t-1e-10)/5e-9);return [t,0,0,0,0,v,d]})
  assert.throws(()=>measureWaveform(rows,{excludeSeconds:2e-8,uiSeconds:3e-9}),/clock_ui/)
  assert.ok(measureWaveform(rows,{excludeSeconds:2e-8,uiSeconds:2.5e-9}).eyeHeightAtCenterV>1.9)
})
test('a partial transient cannot be reported as a completed eye run',()=>{
  const rows=Array.from({length:801},(_,i)=>{const t=i*1e-10,d=Math.sin(2*Math.PI*t/5e-9),v=Math.sin(2*Math.PI*(t-1e-10)/5e-9);return [t,0,0,0,0,v,d]})
  assert.throws(()=>measureWaveform(rows,{excludeSeconds:2e-8,uiSeconds:2.5e-9,durationSeconds:100e-9}),/simulation_duration/)
})
