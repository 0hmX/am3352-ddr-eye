import { fail } from './matrices.mjs'
export function waveformRows(text) {
  const rows=text.trim().split('\n').slice(1).map(r=>r.trim().split(/\s+/).map(Number))
  if(!rows.length||rows.some(r=>r.length!==7||r.some(v=>!Number.isFinite(v)))) fail('waveform','ngspice must generate finite time + six voltage columns')
  for(let i=1;i<rows.length;i++) if(rows[i][0]<=rows[i-1][0]) fail('waveform','Time samples must strictly increase')
  return rows
}
const crossings=(rows,col,start)=>rows.flatMap((r,i)=>{
  if(!i||r[0]<start) return []
  const a=rows[i-1],x=a[col],y=r[col]
  return x*y<0?[{time:a[0]+(r[0]-a[0])*(-x)/(y-x),rising:y>x}]:[]
})
export function measureWaveform(rows,s,eye={endpoint:'receiver',differentialColumn:5,polarity:1,name:'receiver-clock'}) {
  if(Number.isFinite(s.durationSeconds)&&Math.abs(rows.at(-1)[0]/s.durationSeconds-1)>1e-8)
    fail('simulation_duration',`${eye.name}: ngspice waveform ended at ${rows.at(-1)[0]} seconds, expected ${s.durationSeconds}; inspect ngspice logs for incomplete transient`)
  const valid=rows.filter(r=>r[0]>=s.excludeSeconds), out=crossings(rows,5,s.excludeSeconds),drive=crossings(rows,6,s.excludeSeconds)
  if(out.length<8||drive.length<8) fail('stimulus','Insufficient executed receiver transitions for clock eye')
  const selected=rows.map(r=>{const row=[...r];row[5]=r[eye.differentialColumn]*eye.polarity;return row}),eyeCrossings=crossings(selected,5,s.excludeSeconds)
  if(eyeCrossings.length<8) fail('eyediagram',`${eye.name}: insufficient selected probe transitions`)
  const driverIntervals=drive.slice(1).map((c,i)=>c.time-drive[i].time)
  if(driverIntervals.some(dt=>Math.abs(dt/s.uiSeconds-1)>.01)) fail('clock_ui','Executed driver half-period disagrees with declared UI by >1%')
  const delays=out.flatMap(c=>{
    const candidates=drive.filter(d=>d.rising===c.rising&&d.time<=c.time&&c.time-d.time<s.uiSeconds)
    return candidates.length?[c.time-candidates.at(-1).time]:[]
  }).sort((a,b)=>a-b)
  if(delays.length<8) fail('propagation','Unable to match enough source/receiver crossings')
  const phase=eyeCrossings[0].time,samples=[]
  let cycle=0
  for(let target=phase+s.uiSeconds/2;target<rows.at(-1)[0];target+=s.uiSeconds,cycle++) {
    const i=selected.findIndex(r=>r[0]>=target)
    if(i>0) {const a=selected[i-1],b=selected[i];samples.push({value:a[5]+(b[5]-a[5])*(target-a[0])/(b[0]-a[0]),expectedHigh:cycle%2===0?eyeCrossings[0].rising:!eyeCrossings[0].rising})}
  }
  const high=samples.filter(s=>s.expectedHigh).map(s=>s.value),low=samples.filter(s=>!s.expectedHigh).map(s=>s.value)
  if(!high.length||!low.length) fail('eye','Missing both clock levels at center')
  const spacing=eyeCrossings.slice(1).map((c,i)=>c.time-eyeCrossings[i].time)
  return {kind:'deterministic alternating DQS clock eye; no random data or injected jitter',name:eye.name,probeEndpoint:eye.endpoint,probePolarity:eye.polarity,samples:rows.length,receiverTransitions:out.length,eyeTransitions:eyeCrossings.length,steadyStateStartSeconds:s.excludeSeconds,uiSeconds:s.uiSeconds,eyePhaseSeconds:phase,differentialRangeV:[Math.min(...valid.map(r=>r[eye.differentialColumn]*eye.polarity)),Math.max(...valid.map(r=>r[eye.differentialColumn]*eye.polarity))],eyeHeightAtCenterV:Math.min(...high)-Math.max(...low),propagationMedianSeconds:delays[Math.floor(delays.length/2)],propagationRangeSeconds:[delays[0],delays.at(-1)],crossingIntervalRangeSeconds:[Math.min(...spacing),Math.max(...spacing)],simulatedDurationSeconds:rows.at(-1)[0],limitations:['Clock eye only; not data BER, jitter-tolerance or JEDEC compliance','Propagation measured at external pads; excluded TI coupled package and surrounding board structures']}
}

// Validate counts before allocating folded samples or per-window metadata.
function eyeWindowBudget(first,last,pointsPerWindow,{maxWindows=10000,maxSamples=1000000}={}) {
  const windows=last-first+1
  if(![maxWindows,maxSamples].every(value=>Number.isSafeInteger(value)&&value>0)) fail('eye_budget','Eye limits must be positive safe integers')
  if(!Number.isSafeInteger(first)||!Number.isSafeInteger(last)||!Number.isSafeInteger(windows)||windows>maxWindows)
    fail('eye_budget',`Eye windows exceed the limit of ${maxWindows} or have unsafe boundary indices`)
  if(!Number.isSafeInteger(pointsPerWindow)||windows>Math.floor(maxSamples/pointsPerWindow))
    fail('eye_budget',`Eye plotted samples exceed the limit of ${maxSamples}`)
  return windows
}

export function foldEye(rows,metrics,eye,pointsPerWindow=1200,limits={}) {
  if(!Number.isInteger(pointsPerWindow)||pointsPerWindow<2) fail('eye','At least two samples per folded window required')
  const ui=metrics.uiSeconds,origin=metrics.eyePhaseSeconds-ui/2,lastTime=rows.at(-1)[0]
  if(!Number.isFinite(ui)||ui<=0||!Number.isFinite(origin)||!Number.isFinite(metrics.steadyStateStartSeconds)) fail('eye_timing','Positive UI and finite eye timing required')
  const first=Math.max(0,Math.ceil((metrics.steadyStateStartSeconds-origin)/ui)),last=Math.floor((lastTime-origin-2*ui)/ui)
  const count=eyeWindowBudget(first,last,pointsPerWindow,limits),samples=[]
  let windows=0
  for(;windows<count;windows++) {
    const start=origin+(first+windows)*ui
    let index=1
    for(let point=0;point<pointsPerWindow;point++) {
      const offset=2*ui*point/(pointsPerWindow-1),target=start+offset
      while(index<rows.length-1&&rows[index][0]<target) index++
      const a=rows[index-1],b=rows[index],column=eye.differentialColumn
      const value=(a[column]+(b[column]-a[column])*(target-a[0])/(b[0]-a[0]))*eye.polarity
      samples.push([windows,offset,value])
    }
  }
  if(!windows) fail('eye','No complete executed two-UI windows after startTime')
  return {samples,windows,pointsPerWindow}
}

// General measurements consume recorded probe values, never an assumed bit pattern.
export function probeWaveformRows(text,probes) {
  const rows=text.trim().split(/\r?\n/).slice(1).map(line=>line.trim().split(/\s+/).map(Number))
  if(!rows.length||rows.some(row=>row.length!==probes.length+1||row.some(value=>!Number.isFinite(value)))) fail('waveform','Expected actual time and one finite column per declared probe')
  if(rows.some((row,i)=>i&&row[0]<=rows[i-1][0])) fail('waveform','Actual solver timestamps must strictly increase')
  return rows
}

export function foldProbeEye(rows,eye,pointsPerWindow=1200,limits={}) {
  const ui=eye.unitIntervalSeconds,origin=eye.timeOriginSeconds,column=eye.column
  if(!Number.isInteger(pointsPerWindow)||pointsPerWindow<2) fail('eye_resolution','At least two plotting points per window required')
  if(!Number.isFinite(ui)||ui<=0||!Number.isFinite(origin)) fail('eye_timing',`${eye.name}: positive UI and finite timeOrigin required`)
  if(!Number.isInteger(column)||column<1||rows.some(row=>column>=row.length)) fail('eye_probe',`${eye.name}: missing recorded probe column`)
  const start=Math.max(rows[0][0],eye.startTimeSeconds),end=Math.min(rows.at(-1)[0],eye.endTimeSeconds)
  // timeOrigin is the stimulus start/bit-edge origin, not a recovered receive clock.
  // For b_k=origin+k*UI, [b_k-UI/2,b_k+3*UI/2] centers at b_k+UI/2 (mid-bit).
  const epsilon=1e-9 // Boundary tolerance in UI units, independent of the time scale.
  const first=Math.ceil((start+ui/2-origin)/ui-epsilon),last=Math.floor((end-3*ui/2-origin)/ui+epsilon)
  if(!Number.isFinite(first)||!Number.isFinite(last)||first>last) fail('eye_windows',`${eye.name}: no complete two-UI windows within measurement gate [${eye.startTimeSeconds}, ${eye.endTimeSeconds}] s; UI ${ui} s; skip ${(eye.startTimeSeconds-origin)/ui} UI from timeOrigin ${origin} s; recorded timestamps [${rows[0][0]}, ${rows.at(-1)[0]}] s`)
  const count=eyeWindowBudget(first,last,pointsPerWindow,limits)
  const samples=[],windowOriginsSeconds=[],boundaryIndices=[]
  let index=1
  for(let offsetIndex=0;offsetIndex<count;offsetIndex++) {
    const k=first+offsetIndex
    const windowStart=origin+k*ui-ui/2,window=windowOriginsSeconds.length
    windowOriginsSeconds.push(windowStart);boundaryIndices.push(k)
    index=1
    for(let point=0;point<pointsPerWindow;point++) {
      const offset=2*ui*point/(pointsPerWindow-1),time=windowStart+offset
      while(index<rows.length-1&&rows[index][0]<time) index++
      const a=rows[index-1],b=rows[index]
      if(time<a[0]-ui*1e-12||time>b[0]+ui*1e-12) fail('eye_interpolation','Eye sample is outside the recorded waveform')
      samples.push([window,offset,time,a[column]+(b[column]-a[column])*(time-a[0])/(b[0]-a[0])])
    }
  }
  const values=rows.filter(row=>row[0]>=start&&row[0]<=end).map(row=>row[column])
  const range=values.reduce(([low,high],value)=>[Math.min(low,value),Math.max(high,value)],[Infinity,-Infinity])
  return {samples,windows:windowOriginsSeconds.length,pointsPerWindow,windowOriginsSeconds,boundaryIndices,
    metrics:{kind:'finite observed voltage eye',samples:rows.length,voltageRangeV:range,unitIntervalSeconds:ui,timeOriginSeconds:origin,measurementStartSeconds:eye.startTimeSeconds,measurementEndSeconds:eye.endTimeSeconds,observedStartSeconds:rows[0][0],observedEndSeconds:rows.at(-1)[0],windows:windowOriginsSeconds.length,limitations:['No inferred bit levels, clock recovery, eye-opening estimator, BER extrapolation or protocol compliance']}}
}
