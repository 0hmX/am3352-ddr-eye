import test from 'node:test'
import assert from 'node:assert/strict'
import {eyeSimulation,resolveEyeDiagram} from '../src/eyediagram.mjs'
import {measureWaveform,foldEye} from '../src/metrics.mjs'

const geometry={mappings:[{from:'driver-p',to:'receiver-p'},{from:'driver-n',to:'receiver-n'}]}
const declaration={name:'DDR receive eye',positiveSourcePortId:'receiver-p',negativeSourcePortId:'receiver-n',
  unitIntervalSeconds:2.5e-9,durationSeconds:100e-9,timeStepSeconds:10e-12,startTimeSeconds:20e-9}
const modeling={requireNativeEye:true,simulation:{supplyV:1.5,uiSeconds:999}}

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
