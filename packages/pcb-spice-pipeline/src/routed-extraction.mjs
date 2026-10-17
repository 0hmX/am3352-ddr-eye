import {createRequire} from 'node:module'
import {dirname,join} from 'node:path'
import {mkdir,readFile} from 'node:fs/promises'
import {tsImport} from 'tsx/esm/api'
import {json,command,hashes} from './io.mjs'
import {Diagnostic,fail,parseFastHenry,parseFasterCap,validateMatrix} from './matrices.mjs'
import {packageRoot} from './runtime.mjs'

const require=createRequire(import.meta.url)
export async function prepareRoutedExtraction({circuitJson,geometry,modeling,out}) {
  const settings=modeling.routedExtraction
  for(const key of ['marginMm','referenceMeshMm','referenceBoundaryToleranceMm','impedanceSurfaceToleranceMm','surfaceToleranceMm','coordinateGridMm','maximumPanelLengthMm','homogeneousRelativePermittivity']) {
    if(!Number.isFinite(settings?.[key])||settings[key]<=0) fail('routed_settings',`${key} must be explicit and positive`)
  }
  if(!Number.isInteger(settings.signalFilaments)||settings.signalFilaments<1||settings.signalFilaments>15) fail('routed_settings','signalFilaments must be an integer 1..15')
  if(settings.dielectricLossTangent!==0) fail('routed_loss','The constant-RLC backend currently requires explicit dielectricLossTangent=0')
  if(settings.capacitanceGeometry!=='thin-sheets') fail('routed_capacitance','Explicit capacitanceGeometry="thin-sheets" is required; solid-metal layered extraction is not qualified')
  if(!Array.isArray(settings.capMeshEpsilons)||settings.capMeshEpsilons.length<2||settings.capMeshEpsilons.some((value,i)=>!Number.isFinite(value)||value<=0||(i&&value>=settings.capMeshEpsilons[i-1]))) fail('routed_settings','Provide at least two strictly decreasing positive capMeshEpsilons')
  for(const key of ['capInteractionRatio','capLinearTolerance']) if(!Number.isFinite(settings[key])||settings[key]<=0||settings[key]>=1) fail('routed_settings',`${key} must lie strictly between zero and one`)
  validateCorrectionPolicy(settings.capacitanceCorrection)
  if(modeling.viaPlatingMm!==0.025) fail('routed_plating','The pinned physical geometry converter requires explicit viaPlatingMm=0.025')
  const root=dirname(require.resolve('circuit-json-to-gmsh/package.json'))
  const {createGeometryModel,createMeshRequirements}=await tsImport(join(root,'lib/index.ts'),{parentURL:import.meta.url})
  const copper=[...modeling.boardConstruction.copperLayers].sort((a,b)=>b.zMinMm-a.zMinMm)
  const layers=[]
  for(const [i,foil] of copper.entries()) {
    layers.push({name:foil.name,copperThicknessMm:foil.zMaxMm-foil.zMinMm})
    if(i===copper.length-1) continue
    const lower=copper[i+1]
    const dielectric=modeling.boardConstruction.dielectrics.find(d=>Math.abs(d.zMinMm-lower.zMaxMm)<1e-8&&Math.abs(d.zMaxMm-foil.zMinMm)<1e-8)
    if(!dielectric) fail('routed_stackup',`Missing explicit dielectric between ${foil.name} and ${lower.name}`)
    layers.push({material:dielectric.material,dielectricThicknessMm:dielectric.zMaxMm-dielectric.zMinMm,dielectricConstant:dielectric.relativePermittivity,lossTangent:modeling.routedExtraction.dielectricLossTangent})
  }
  const model=createGeometryModel({circuitJson,stackup:{layers},viaClearance:1e-6})
  const connections=modeling.lanes.map(lane=>({from:`${lane.from.component}.${lane.from.port}`,to:`${lane.to.component}.${lane.to.port}`}))
  const references=modeling.routedExtraction.referencePorts
  if(!Array.isArray(references)||!references.length) fail('routed_reference','Explicit reference source/receiver ports are required')
  const requirements=createMeshRequirements({circuitJson,model,connections:[...connections,...references.map(ref=>({from:`${ref.from.component}.${ref.from.port}`,to:`${ref.to.component}.${ref.to.port}`}))]})
  const terminals=new Map(requirements.terminals.map(t=>[t.name,t]))
  const signals=connections.map((connection,i)=>({name:modeling.lanes[i].port,from:terminals.get(connection.from),to:terminals.get(connection.to),route:geometry.mappings[i].originalRoute}))
  const returns=references.map((ref,i)=>({name:ref.name??`reference${i}`,from:terminals.get(`${ref.from.component}.${ref.from.port}`),to:terminals.get(`${ref.to.component}.${ref.to.port}`)}))
  if([...signals,...returns].some(path=>!path.from||!path.to||path.from.netId!==path.to.netId)) fail('routed_terminal','Reference and signal endpoints must each resolve to the same physical net')
  const selected=new Set([...signals,...returns].map(path=>path.from.netId))
  if(new Set(signals.map(signal=>signal.from.netId)).size!==signals.length||signals.some(signal=>returns.some(reference=>reference.from.netId===signal.from.netId))) fail('routed_nets','Signal nets must be distinct and separate from selected references')
  // Preserve all source barrels for their drill/antipad voids, even on excluded nets.
  const context={model,signals,returns,settings:{...settings,modelHz:modeling.extraction.modelHz},conductivitySm:modeling.conductivitySm,pythonGeometryPath:join(root,'lib/python'),selectedNetIds:[...selected],sourceGeometryPackage:{name:'circuit-json-to-gmsh',commit:'9c7f34b7e502b8339a6659cb268b1540867a672d',files:await hashes(root,'lib')},physicalAssumptions:{viaPlatingMm:0.025,circularPolygonSides:32,additionalViaClearanceMm:1e-6,referenceTreatment:'Selected rails ideal AC-connected at source and receiver'}}
  await mkdir(out,{recursive:true});await json(join(out,'physical-input.json'),context)
  return context
}

export function capacitanceRefinementResidual(previous,current) {
  return Math.max(...current.flatMap((row,i)=>row.map((value,j)=>Math.abs(value-previous[i][j])/Math.sqrt(current[i][i]*current[j][j]))))
}

export function extractionConsistencyDiagnostics({R,L,C,geometry,relativePermittivity}) {
  const signalOrder=geometry.mappings.map(lane=>lane.port)
  if([R,L,C].some(matrix=>matrix.length!==signalOrder.length||matrix.some(row=>row.length!==signalOrder.length))) fail('routed_diagnostics','Matrix dimensions must match saved routed lane order')
  const normalized=(matrix,i,j)=>matrix[i][j]/Math.sqrt(matrix[i][i]*matrix[j][j])
  const pairs=signalOrder.flatMap((signal,i)=>signalOrder.slice(i+1).map((other,offset)=>{
    const j=i+offset+1
    return {i,j,signals:[signal,other],inductiveCoupling:normalized(L,i,j),electrostaticCoupling:-normalized(C,i,j),resistiveCoupling:normalized(R,i,j)}
  }))
  const lanes=geometry.mappings.map((lane,i)=>{
    const routeLengthMm=lane.stages.reduce((sum,stage)=>sum+stage.lengthMm,0)
    const homogeneousIdealLineDelaySeconds=routeLengthMm/1000*Math.sqrt(relativePermittivity)/299792458
    const diagonalLcDelayProxySeconds=Math.sqrt(L[i][i]*C[i][i])
    return {i,signal:lane.port,pcbTraceId:lane.pcbTraceId,routeLengthMm,activeViaLengthMm:lane.stages.filter(stage=>stage.kind==='via').reduce((sum,stage)=>sum+stage.lengthMm,0),homogeneousIdealLineDelaySeconds,diagonalLcDelayProxySeconds,diagonalToIdealDelayRatio:diagonalLcDelayProxySeconds/homogeneousIdealLineDelaySeconds}
  })
  return {interpretation:'Consistency clues, not pass/fail physical accuracy bounds; finite resistance, internal inductance, finite return access, vias, nonuniform routes and coupled modes affect these comparisons',signalOrder,relativePermittivity,definitions:{inductiveCoupling:'Lij/sqrt(Lii*Ljj)',electrostaticCoupling:'-Cij/sqrt(Cii*Cjj), using the grounded capacitance stamped into the channel',resistiveCoupling:'Rij/sqrt(Rii*Rjj)',routeLengthMm:'Saved route wire centreline lengths plus active via layer-transition lengths; unconnected via stubs excluded from this length proxy',homogeneousIdealLineDelaySeconds:'routeLengthMetres*sqrt(explicit relativePermittivity)/299792458',diagonalLcDelayProxySeconds:'sqrt(Lii*Cii); a scalar diagonal ladder delay proxy, not a coupled-mode propagation delay'},pairs,lanes}
}

function validateCorrectionPolicy(policy) {
  if(policy===undefined) return
  if(!policy||!Number.isFinite(policy.maximumEnergyFraction)||policy.maximumEnergyFraction<=0||policy.maximumEnergyFraction>=1||!Number.isFinite(policy.maximumWaveformDifferenceV)||policy.maximumWaveformDifferenceV<=0) fail('routed_settings','capacitanceCorrection requires maximumEnergyFraction between zero and one and positive maximumWaveformDifferenceV')
}

export function validateMaxwellCapacitance(matrix,tolerance=0.02,policy) {
  validateCorrectionPolicy(policy)
  const checked=validateMatrix(matrix,'C routed primitive',tolerance)
  const pairReciprocityResidual=capacitanceRefinementResidual(matrix,matrix.map((_,i)=>matrix.map(row=>row[i])))
  if(pairReciprocityResidual>tolerance) fail('reciprocity',`C routed primitive: pair-normalized residual ${pairReciprocityResidual} > ${tolerance}`)
  if([...matrix,...checked.matrix].some(row=>row.reduce((a,b)=>a+b,0)<=0)) fail('routed_capacitance','Primitive Maxwell capacitance requires positive raw and symmetric row sums before correction')
  const rawMaximumPositiveMutualF=Math.max(0,...matrix.flatMap((row,i)=>row.filter((_,j)=>i!==j)))
  if(!policy) {
    if(rawMaximumPositiveMutualF>0) fail('routed_capacitance','Primitive Maxwell capacitance requires negative mutual coefficients or exact zero; bounded correction must be explicit')
    return {...checked,pairReciprocityResidual,capacitanceCorrection:null}
  }
  const symmetricMatrix=checked.matrix,correctionMatrix=matrix.map(row=>row.map(()=>0)),correctedPairs=[]
  let conservativeMaximumEnergyFraction=0
  for(let i=0;i<matrix.length;i++) for(let j=i+1;j<matrix.length;j++) {
    const amount=symmetricMatrix[i][j]
    if(amount<=0) continue
    // E = sum a_ij (e_i-e_j)(e_i-e_j)^T preserves row sums and is PSD.
    correctionMatrix[i][i]+=amount;correctionMatrix[j][j]+=amount
    correctionMatrix[i][j]-=amount;correctionMatrix[j][i]-=amount
    correctedPairs.push({i,j,rawCoefficientF:matrix[i][j],transposeCoefficientF:matrix[j][i],symmetricPositiveCoefficientF:amount})
    const solved=[]
    for(let row=0;row<matrix.length;row++) solved[row]=((Number(row===i)-Number(row===j))-solved.reduce((sum,value,k)=>sum+checked.cholesky[row][k]*value,0))/checked.cholesky[row][row]
    // trace(S^-1 E) bounds the largest relative energy eigenvalue from above.
    conservativeMaximumEnergyFraction+=amount*solved.reduce((sum,value)=>sum+value*value,0)
  }
  const projectedMatrix=symmetricMatrix.map((row,i)=>row.map((value,j)=>value+correctionMatrix[i][j]))
  const capacitanceCorrection={method:'row-sum-preserving-positive-mutual-removal',energyBound:'trace(S^-1 E); conservative bound on relative fixed-voltage capacitance energy change',policy,correctedPairs,conservativeMaximumEnergyFraction,rawMaximumPositiveMutualF,rawMatrix:matrix,symmetricMatrix,correctionMatrix,projectedMatrix}
  if(!Number.isFinite(conservativeMaximumEnergyFraction)||conservativeMaximumEnergyFraction>policy.maximumEnergyFraction) {
    const error=new Diagnostic('routed_capacitance',`Explicit Maxwell correction energy bound ${conservativeMaximumEnergyFraction} exceeds declared ${policy.maximumEnergyFraction}`)
    error.capacitanceCorrection=capacitanceCorrection;throw error
  }
  const projected=validateMatrix(projectedMatrix,'C routed corrected primitive',tolerance)
  if(projected.matrix.some((row,i)=>row.some((value,j)=>i!==j&&value>0)||row.reduce((a,b)=>a+b,0)<=0)) fail('routed_capacitance','Explicit Maxwell correction did not produce nonpositive mutuals and positive row sums')
  return {...projected,reciprocityResidual:checked.reciprocityResidual,pairReciprocityResidual,capacitanceCorrection}
}

export async function extractCapacitance({tools,context,modeling,dir}) {
  const settings=context.settings,history=[]
  let previous
  for(const [index,mesh] of settings.capMeshEpsilons.entries()) {
    const label=`fastercap-${index}`
    const run=await command(tools.fastercap,['channel.lst','-b','-g',`-m${mesh}`,`-d${settings.capInteractionRatio}`,`-t${settings.capLinearTolerance}`,'-e'],dir,label)
    if(/zero self-potential|self-potential calculation equal to zero|not converging|explicit residual check failed|\bnan\b/i.test(run.stdout+run.stderr)) {
      history.push({mesh,label,status:'linear-solve-failed'});await json(join(dir,'capacitance-refinement.json'),history);continue
    }
    const cap=parseFasterCap(run.stdout)
    if(cap.matrix.length!==context.signals.length+1||!cap.names.every((name,i)=>name.endsWith(`_${i===context.signals.length?'REF':`SIG${i}`}`))) fail('matrix_order','Native routed capacitance count/order mismatch')
    let checked
    try {checked=validateMaxwellCapacitance(cap.matrix,modeling.extraction.capTolerance,settings.capacitanceCorrection)}
    catch(error) {
      if(!['reciprocity','passivity','routed_capacitance'].includes(error.code)) throw error
      const correction=error.capacitanceCorrection
      // A correction-budget overrun excludes the electrical model, but the
      // converged raw matrix can still measure numerical refinement.
      const referenceOnly=Number.isFinite(correction?.conservativeMaximumEnergyFraction)&&correction.conservativeMaximumEnergyFraction>settings.capacitanceCorrection?.maximumEnergyFraction
      if(referenceOnly) previous={...cap,label}
      history.push({mesh,label,status:referenceOnly?'refinement-reference-only':'physical-check-failed',diagnostic:error.message,matrix:cap.matrix,capacitanceCorrection:correction});await json(join(dir,'capacitance-refinement.json'),history);continue
    }
    const residual=previous?capacitanceRefinementResidual(previous.matrix,cap.matrix):null
    history.push({mesh,label,status:'solved',matrix:cap.matrix,reciprocityResidual:checked.reciprocityResidual,pairReciprocityResidual:checked.pairReciprocityResidual,refinementResidual:residual,refinementReferenceLabel:previous?.label??null,capacitanceCorrection:checked.capacitanceCorrection})
    await json(join(dir,'capacitance-refinement.json'),history)
    if(residual!==null&&residual<=modeling.extraction.capTolerance) {
      if(checked.capacitanceCorrection) await json(join(dir,'capacitance-correction.json'),checked.capacitanceCorrection)
      return {...cap,projectedMatrix:checked.matrix,capacitanceCorrection:checked.capacitanceCorrection,refinement:history}
    }
    previous={...cap,label}
  }
  fail('cap_convergence','Routed capacitance needs a policy-valid final matrix within the declared raw refinement tolerance of a converged native reference')
}

export async function extractRoutedChannel({circuitJson,geometry,modeling,out,tools,python,onProgress=()=>{}}) {
  const dir=join(out,'routed-extraction')
  const context=await prepareRoutedExtraction({circuitJson,geometry,modeling,out:dir})
  onProgress(`Extract ${context.signals.length} actual routed signals with saved reference copper`)
  await command(python,[join(packageRoot,'scripts/routed-geometry.py'),join(dir,'physical-input.json'),dir],dir,'geometry')
  const inductanceRun=await command(tools.fasthenry,['channel.inp','-c','600','-D','on'],dir,'fasthenry')
  if(/Convergence not reached|mutual inductance = infinity|\bnan\b/i.test(inductanceRun.stdout+inductanceRun.stderr)) fail('routed_inductance','Native routed impedance reported nonconvergence or a nonfinite kernel')
  const geometrySummary=JSON.parse(await readFile(join(dir,'geometry-summary.json'),'utf8'))
  const impedanceText=await readFile(join(dir,'Zc.mat'),'utf8')
  for(const [i,[a,b]] of geometrySummary.inductance.portNodes.entries()) if(!new RegExp(`Row ${i+1}:\\s+${a}\\s+to\\s+${b}`,'i').test(impedanceText)) fail('matrix_order','Native routed impedance port order mismatch')
  const impedance=parseFastHenry(impedanceText)
  const selected=impedance.find(sample=>Math.abs(sample.frequencyHz/modeling.extraction.modelHz-1)<1e-8)
  if(!selected||selected.R.length!==context.signals.length) fail('routed_ports','Native impedance port count/frequency mismatch')
  const cap=await extractCapacitance({tools,context,modeling,dir})
  const R=validateMatrix(selected.R,'R routed'),L=validateMatrix(selected.L,'L routed')
  validateMatrix(cap.matrix,'C routed primitive')
  // All selected reference conductors are explicitly held at incremental AC zero.
  const rawC=validateMatrix(cap.matrix.slice(0,-1).map(row=>row.slice(0,-1)),'C routed raw signed')
  const C=validateMatrix(cap.projectedMatrix.slice(0,-1).map(row=>row.slice(0,-1)),'C routed')
  if(C.matrix.some((row,i)=>row.some((entry,j)=>i!==j&&entry>0)||row.reduce((a,b)=>a+b,0)<=0)) fail('routed_capacitance','Invalid grounded Maxwell capacitance signs')
  const consistencyDiagnostics=extractionConsistencyDiagnostics({R:R.matrix,L:L.matrix,C:C.matrix,geometry,relativePermittivity:context.settings.homogeneousRelativePermittivity})
  const result={stage:0,profile:'actual-routed-shapes',R:R.matrix,L:L.matrix,C:C.matrix,rawGroundedCapacitance:rawC.matrix,capacitanceCorrection:cap.capacitanceCorrection,consistencyDiagnostics,units:{R:'ohm',L:'H',C:'F'},frequencyHz:selected.frequencyHz,signalOrder:context.signals.map(signal=>signal.name),checks:{R,L,C,rawC,capacitanceRefinement:cap.refinement},primitiveImpedance:impedance,primitiveCapacitance:cap.matrix,geometry:geometrySummary,conversions:{capacitance:`Selected reference planes fixed at incremental AC zero; signal Maxwell submatrix retained${cap.capacitanceCorrection?'; explicit bounded row-sum-preserving sign correction reported separately':''}`,channel:'Whole-route quasistatic matrices homogenized over the declared pi sections'}}
  await json(join(dir,'consistency-diagnostics.json'),consistencyDiagnostics)
  await json(join(dir,'extraction.json'),result)
  return [result]
}
