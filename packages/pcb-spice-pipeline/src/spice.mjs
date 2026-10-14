import { fail, scale, sum } from './matrices.mjs'
const num=v=>Number(v.toPrecision(12)).toString()
export function channelSpice(extracted,sections) {
  const n=extracted[0].R.length
  const lines=['* Constant frequency passive matrix pi channel; local neutral finite return reference',`.subckt CHANNEL ${Array.from({length:n},(_,i)=>`IN${i}`).concat(Array.from({length:n},(_,i)=>`OUT${i}`),'REF').join(' ')}`]
  let global=0
  for(const [stage,e] of extracted.entries()) for(let section=0;section<sections;section++) {
    const g=global++,R=scale(e.R,1/sections),L=scale(e.L,1/sections),C=scale(e.C,1/sections)
    const first=g===0,last=stage===extracted.length-1&&section===sections-1
    const before=Array.from({length:n},(_,i)=>first?`IN${i}`:`N${g}_${i}`),after=Array.from({length:n},(_,i)=>last?`OUT${i}`:`N${g+1}_${i}`)
    for(let i=0;i<n;i++) {
      lines.push(`VS${g}_${i} ${before[i]} S${g}_${i} 0`,`R${g}_${i} S${g}_${i} R${g}_${i} ${num(R[i][i])}`)
      // Full symmetric R: self resistor plus cross voltage R_ij * I_j.
      if(n===2) lines.push(`E${g}_${i} R${g}_${i} L${g}_${i} value={${num(R[i][1-i])}*i(VS${g}_${1-i})}`)
      lines.push(`L${g}_${i} ${n===2?`L${g}_${i}`:`R${g}_${i}`} ${after[i]} ${num(L[i][i])}`)
    }
    if(n===2) lines.push(`K${g} L${g}_0 L${g}_1 ${num(L[0][1]/Math.sqrt(L[0][0]*L[1][1]))}`)
    for(const [label,nodes] of [['a',before],['b',after]]) {
      for(let i=0;i<n;i++) lines.push(`CG${g}${label}${i} ${nodes[i]} REF ${num(sum(C[i])/2)}`)
      if(n===2&&C[0][1]<0) lines.push(`CM${g}${label} ${nodes[0]} ${nodes[1]} ${num(-C[0][1]/2)}`)
    }
  }
  lines.push('.ends CHANNEL')
  return lines.join('\n')+'\n'
}
function instance(label,converted,signalNodes,ports) {
  const wrapper=converted.source.match(/^\.subckt\s+(\S+)\s+(.+)$/mi)
  if(!wrapper) fail('ibis_contract','Converter did not emit a component wrapper')
  const nodes=wrapper[2].trim().split(/\s+/).map(terminal=>{
    const mapped=converted.spicePinMapping[terminal]
    if(mapped===ports.vdd) return 'vdd'
    if(mapped===ports.vss) return '0'
    if(!Object.hasOwn(signalNodes,mapped)) fail('ibis_mapping',`Unknown returned terminal ${terminal} -> ${mapped}`)
    return signalNodes[mapped]
  })
  return `X${label} ${nodes.join(' ')} ${wrapper[1]}`
}
export function simulationSpice(modeling,extracted,driver,receiver) {
  const s=modeling.simulation
  if(!Number.isFinite(s.supplyV)||s.supplyV<=0) fail('power','Explicit simulation.supplyV required')
  const driverNodes=Object.fromEntries(modeling.lanes.map((l,i)=>[l.driverPort??l.port,`drv${i}`])),receiverNodes=Object.fromEntries(modeling.lanes.map((l,i)=>[l.receiverPort??l.port,`rx${i}`]))
  if(new Set(Object.values(driverNodes).concat(Object.values(receiverNodes))).size!==4) fail('channel_short','Driver and receiver must have four distinct nodes')
  return ['PCB extracted channel with original vendor IBIS tables','.options reltol=1e-5 abstol=1e-12 method=gear',`VDD vdd 0 ${num(s.supplyV)}`,driver.source,receiver.source,channelSpice(extracted,modeling.sections),instance('DRIVER',driver,driverNodes,modeling.driver.power),instance('RECEIVER',receiver,receiverNodes,modeling.receiver.power),'XCHAN drv0 drv1 rx0 rx1 0 CHANNEL','.control','set wr_singlescale','set wr_vecnames',`tran ${num(s.stepSeconds)} ${num(s.durationSeconds)} 0 ${num(s.stepSeconds)}`,'let vdiff = v(rx0)-v(rx1)','let vdrive = v(drv0)-v(drv1)','wrdata waveform.dat v(drv0) v(drv1) v(rx0) v(rx1) vdiff vdrive','quit','.endc','.end',''].join('\n')
}
