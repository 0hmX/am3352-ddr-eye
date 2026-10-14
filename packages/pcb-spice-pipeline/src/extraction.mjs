import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {join} from 'node:path'
import {fastHenryDeck,fasterCapDeck} from './geometry.mjs'
import {fail,parseFastHenry,parseFasterCap,validateMatrix,loopImpedance,referenceCapacitance,multiply,transpose,sum} from './matrices.mjs'
import {command,json} from './io.mjs'
export async function extractChannel(geometry,modeling,out,tools,onProgress=()=>{}) {
  const extracted=[]
  for(const cell of geometry.cells) {
    onProgress(`Extract stage ${cell.stage} (${cell.profile}) with actual native FastHenry and FasterCap`)
    const dir=join(out,`stage-${cell.stage}`);await mkdir(dir)
    await writeFile(join(dir,'channel.inp'),fastHenryDeck(cell,modeling.extraction))
    const fc=fasterCapDeck(cell,modeling.extraction)
    for(const [file,body] of Object.entries(fc)) await writeFile(join(dir,file),body)
    await command(tools.fasthenry,['channel.inp'],dir,'fasthenry')
    const ztext=await readFile(join(dir,'Zc.mat'),'utf8')
    for(let i=0;i<cell.conductors.length;i++) if(!new RegExp(`Row ${i+1}:\\s+N${i}a\\s+to\\s+N${i}b`,'i').test(ztext)) fail('matrix_order','FastHenry external port ordering disagrees with declared signals/return')
    const spectrum=parseFastHenry(ztext)
    const lowest=spectrum.reduce((a,b)=>a.frequencyHz<b.frequencyHz?a:b),coarse=spectrum.find(s=>Math.abs(s.frequencyHz/modeling.extraction.modelHz-1)<1e-8)
    if(!coarse) fail('model_frequency','modelHz must be one executed FastHenry sample frequency')
    const refinement=join(dir,'refinement');await mkdir(refinement)
    await writeFile(join(refinement,'channel.inp'),fastHenryDeck(cell,{...modeling.extraction,minimumHz:modeling.extraction.modelHz,maximumHz:modeling.extraction.modelHz,filaments:modeling.extraction.refinementFilaments}))
    await command(tools.fasthenry,['channel.inp'],refinement,'fasthenry')
    const selected=parseFastHenry(await readFile(join(refinement,'Zc.mat'),'utf8'))[0]
    const convergence={coarseFilaments:modeling.extraction.filaments,refinedFilaments:modeling.extraction.refinementFilaments,frequencyHz:selected.frequencyHz,definition:'max(abs(refined-coarse))/max(abs(refined)) for full referenced matrix',tolerance:modeling.extraction.convergenceTolerance}
    for(const kind of ['R','L']) {
      const a=loopImpedance(coarse[kind]),b=loopImpedance(selected[kind])
      convergence[kind]=Math.max(...b.flatMap((r,i)=>r.map((v,j)=>Math.abs(v-a[i][j]))))/Math.max(...b.flat().map(Math.abs))
      if(convergence[kind]>convergence.tolerance) fail('mesh_convergence',`Stage ${cell.stage} ${kind} filament refinement residual ${convergence[kind]} > ${convergence.tolerance}; increase both mesh counts explicitly`)
    }
    const analytic=cell.conductors.map(c=>c.lengthM/(cell.conductivitySm*c.widthM*c.thicknessM))
    const errors=analytic.map((v,i)=>Math.abs(lowest.R[i][i]/v-1))
    if(errors.some(e=>e>modeling.extraction.dcResistanceTolerance)) fail('analytic_resistance',`DC geometry check failed: errors ${errors.join(',')}`)
    const analyticLoop=loopImpedance(analytic.map((v,i)=>analytic.map((_,j)=>i===j?v:0))),dcLoop=loopImpedance(lowest.R)
    const dcLoopResidual=Math.max(...dcLoop.flatMap((r,i)=>r.map((v,j)=>Math.abs(v-analyticLoop[i][j]))))/Math.max(...analyticLoop.flat())
    if(dcLoopResidual>modeling.extraction.dcResistanceTolerance) fail('analytic_return',`Shared-return DC resistance mismatch ${dcLoopResidual}`)
    const R=validateMatrix(loopImpedance(selected.R),'R loop',modeling.extraction.reciprocityTolerance),L=validateMatrix(loopImpedance(selected.L),'L loop',modeling.extraction.reciprocityTolerance)
    validateMatrix(selected.R,'R primitive',modeling.extraction.reciprocityTolerance);validateMatrix(selected.L,'L primitive',modeling.extraction.reciprocityTolerance)
    const capRun=await command(tools.fastercap,['channel.lst','-b',`-a${modeling.extraction.capTolerance}`,'-e'],dir,'fastercap')
    const cap=parseFasterCap(capRun.stdout)
    const capDiff=[...capRun.stdout.matchAll(/Weighted Frobenius norm of the difference between capacitance \(auto option\):\s*([\deE+.-]+)/g)].at(-1)
    const capConvergence=capDiff?Number(capDiff[1]):null
    if(capConvergence===null||capConvergence>modeling.extraction.capTolerance) fail('cap_convergence','FasterCap did not report converged automatic refinement within requested tolerance')
    if(!cap.names.every((n,i)=>n.endsWith(`_${cell.conductors[i].name}`))) fail('matrix_order',`FasterCap C conductor ordering changed: ${cap.names}`)
    const primitiveC=validateMatrix(cap.matrix,'C primitive',modeling.extraction.reciprocityTolerance),C=referenceCapacitance(primitiveC.matrix)
    if(primitiveC.matrix.some((r,i)=>sum(r)<=0||r.some((v,j)=>i!==j&&v>0))) fail('capacitance_sign','Primitive Maxwell matrix needs nonpositive off-diagonals and positive capacitance to infinity')
    const cr=primitiveC.matrix.map(sum),v=cell.conductors.slice(0,-1).map((_,i)=>i===0?1.2:-.7),offset=-sum(v.map((value,i)=>cr[i]*value))/C.denominator,full=v.map(value=>[value+offset]).concat([[offset]]),q=multiply(primitiveC.matrix,full)
    const energy=multiply(transpose(full),q)[0][0],reducedEnergy=multiply(multiply([v],C.matrix),transpose([v]))[0][0]
    const energyResidual=Math.abs(energy-reducedEnergy)/Math.abs(energy),neutralityResidual=Math.abs(sum(q.flat()))/Math.max(...q.flat().map(Math.abs))
    if(energyResidual>1e-10||neutralityResidual>1e-10) fail('reference_energy','Neutral finite-return charge/energy reconstruction failed')
    const result={stage:cell.stage,profile:cell.profile,R:R.matrix,L:L.matrix,C:C.matrix,units:{R:'ohm',L:'H',C:'F'},frequencyHz:selected.frequencyHz,primitiveOrder:cell.conductors.map(c=>c.name),primitiveImpedance:spectrum,modelPrimitiveImpedance:selected,primitiveCapacitance:cap.matrix,checks:{R,L,C,primitiveC,convergence,capConvergence,analyticResistanceOhm:analytic,analyticResistanceRelativeErrors:errors,analyticFrequencyHz:lowest.frequencyHz,analyticLoopResistanceOhm:analyticLoop,dcLoopResidual,energyResidual,neutralityResidual},conversions:{impedance:'R=Re(Z), L=Im(Z)/(2*pi*f); A=[I;-ones]; loop=A^T primitive A',capacitance:C.convention,neutralityDenominatorF:C.denominator}}
    await json(join(dir,'extraction.json'),result);extracted.push(result)
  }
  return extracted
}
