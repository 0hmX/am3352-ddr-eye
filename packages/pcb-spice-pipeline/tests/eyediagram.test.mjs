import test from 'node:test'
import assert from 'node:assert/strict'
import {eyeSimulation,resolveEyeDiagram} from '../src/eyediagram.mjs'
import {measureWaveform,foldEye,foldProbeEye} from '../src/metrics.mjs'

const geometry={mappings:[{from:'driver-p',to:'receiver-p'},{from:'driver-n',to:'receiver-n'}]}
const declaration={name:'DDR receive eye',positiveSourcePortId:'receiver-p',negativeSourcePortId:'receiver-n',
  unitIntervalSeconds:2.5e-9,durationSeconds:100e-9,timeStepSeconds:10e-12,startTimeSeconds:20e-9}
const modeling={requireNativeEye:true,simulation:{supplyV:1.5,uiSeconds:999}}

test('empty eye gate reports timing and skipped UIs instead of an empty eye',()=>{
  const eye={name:'DQ0',column:1,unitIntervalSeconds:2.5e-9,timeOriginSeconds:0,
    startTimeSeconds:40e-9,endTimeSeconds:45e-9}
  const rows=[[0,0],[40e-9,1],[45e-9,0]]
  assert.throws(()=>foldProbeEye(rows,eye,5),error=>{
    assert.equal(error.code,'eye_windows')
    assert.match(error.message,/DQ0: no complete two-UI windows/)
    assert.ok(error.message.includes(`gate [${eye.startTimeSeconds}, ${eye.endTimeSeconds}] s`))
    assert.ok(error.message.includes(`UI ${eye.unitIntervalSeconds} s`))
    assert.match(error.message,/skip 16 UI/)
    return true
  })
})

test('two-UI eye windows center half a UI after stimulus bit boundaries',()=>{
  const ui=2.5e-9,origin=1.25e-9
  const eye={name:'DQ0',column:1,unitIntervalSeconds:ui,timeOriginSeconds:origin,
    startTimeSeconds:origin+16*ui,endTimeSeconds:origin+20*ui}
  // A ramp makes interpolated voltage equal absolute time, independent of bit levels.
  const folded=foldProbeEye([[0,0],[100e-9,100e-9]],eye,5)
  assert.deepEqual(folded.boundaryIndices,[17,18])
  assert.equal(folded.windows,2)
  for(const [window,offset,time,value] of folded.samples) {
    const boundary=origin+folded.boundaryIndices[window]*ui
    assert.ok(Math.abs(time-(boundary-ui/2+offset))<1e-22)
    assert.ok(Math.abs(value-time)<1e-22)
    if(offset===ui) assert.ok(Math.abs(time-(boundary+ui/2))<1e-22)
  }
})

test('native element owns timing and resolves selected physical receiver probes',()=>{
  const result=eyeSimulation(modeling,[declaration]),eye=resolveEyeDiagram(geometry,result,[declaration])
  assert.equal(result.simulation.uiSeconds,2.5e-9)
  assert.equal(result.simulation.durationSeconds,100e-9)
  assert.equal(result.simulation.excludeSeconds,20e-9)
  assert.equal(result.simulation.supplyV,1.5)
  assert.equal(modeling.simulation.uiSeconds,999)
  assert.equal(eye.origin,'native-tsx-element')
  assert.deepEqual(eye.spiceNodes,['rx0','rx1'])
  assert.equal(eye.differentialColumn,5)
})

test('driver probes and reversed polarity are explicit; unrelated/mixed probes fail',()=>{
  const reverse={...declaration,positiveSourcePortId:'driver-n',negativeSourcePortId:'driver-p'}
  const eye=resolveEyeDiagram(geometry,modeling,[reverse])
  assert.equal(eye.endpoint,'driver');assert.equal(eye.polarity,-1)
  assert.equal(eye.differentialColumn,6);assert.deepEqual(eye.spiceNodes,['drv1','drv0'])
  assert.throws(()=>resolveEyeDiagram(geometry,modeling,[{...declaration,positiveSourcePortId:'driver-p'}]),/mixed endpoints/)
  assert.throws(()=>resolveEyeDiagram(geometry,modeling,[{...declaration,negativeSourcePortId:'unrelated'}]),/unsupported/)
})

test('missing, ambiguous and invalid eye declarations fail before any solver runs',()=>{
  assert.throws(()=>eyeSimulation(modeling,[]),/native <eyediagram>/)
  assert.throws(()=>eyeSimulation(modeling,[declaration,declaration]),/exactly one/)
  assert.throws(()=>eyeSimulation(modeling,[{...declaration,startTimeSeconds:100e-9}]),/before duration/)
  assert.throws(()=>eyeSimulation(modeling,[{...declaration,timeStepSeconds:1e-9}]),/resolve a UI/)
  assert.equal(eyeSimulation(modeling,[{...declaration,startTimeSeconds:0}]).simulation.excludeSeconds,0)
})

test('selected driver eye and folded samples come from the declared measured column',()=>{
  const rows=Array.from({length:1001},(_,i)=>{
    const t=i*1e-10,drive=2*Math.sin(2*Math.PI*t/5e-9),receive=Math.sin(2*Math.PI*(t-1e-10)/5e-9)
    return [t,drive/2,-drive/2,receive/2,-receive/2,receive,drive]
  })
  const eye=resolveEyeDiagram(geometry,modeling,[{...declaration,positiveSourcePortId:'driver-n',negativeSourcePortId:'driver-p'}])
  const s=eyeSimulation(modeling,[declaration]).simulation,metrics=measureWaveform(rows,s,eye)
  assert.equal(metrics.probeEndpoint,'driver');assert.equal(metrics.probePolarity,-1)
  assert.ok(metrics.eyeHeightAtCenterV>3.9)
  const folded=foldEye(rows,metrics,eye,3)
  assert.ok(folded.windows>20);assert.equal(folded.samples.length,folded.windows*3)
  for(const [window,offset,value] of folded.samples) {
    const first=metrics.eyePhaseSeconds-s.uiSeconds/2
    const initial=first>=s.excludeSeconds?first:first+Math.ceil((s.excludeSeconds-first)/s.uiSeconds)*s.uiSeconds
    const time=initial+window*s.uiSeconds+offset
    const i=rows.findIndex(r=>r[0]>=time),a=rows[i-1],b=rows[i]
    const expected=-(a[6]+(b[6]-a[6])*(time-a[0])/(b[0]-a[0]))
    assert.ok(Math.abs(value-expected)<1e-12)
  }
})

test('aligned nanosecond gates tolerate floating-point roundoff at either boundary',()=>{
  for(const scale of [1e-3,1,1e3]) {
    // Match the native ns -> Circuit JSON ms -> seconds conversion.
    const ui=2.5*1e-6/1000*scale,start=41.25e-9*scale,end=46.250001e-9*scale
    const eye={name:'DQ0',column:1,unitIntervalSeconds:ui,timeOriginSeconds:0,
      startTimeSeconds:start,endTimeSeconds:end}
    const folded=foldProbeEye([[0,0],[100e-9*scale,100e-9*scale]],eye,5)
    assert.deepEqual(folded.boundaryIndices,[17])
    assert.equal(folded.windows,1)
    for(const [,,time,value] of folded.samples) assert.ok(Math.abs(value-time)<ui*1e-12)
    // Rounding at the end of a recorded waveform must also preserve the window.
    assert.equal(foldProbeEye([[start,0],[start+2*ui,1]],{...eye,endTimeSeconds:start+2*ui},5).windows,1)
    assert.throws(()=>foldProbeEye([[0,0],[100e-9*scale,0]],{...eye,startTimeSeconds:start+ui*1e-6},5),/eye_windows/)
    assert.throws(()=>foldProbeEye([[0,0],[100e-9*scale,0]],{...eye,endTimeSeconds:start+2*ui-ui*1e-6},5),/eye_windows/)
  }
})
