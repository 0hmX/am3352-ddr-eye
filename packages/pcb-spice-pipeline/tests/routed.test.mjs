import test from 'node:test'
import assert from 'node:assert/strict'
import {chmod,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {loadEntry} from '../src/pipeline.mjs'
import {geometryFromCircuitJson} from '../src/geometry.mjs'
import {prepareRoutedExtraction,capacitanceRefinementResidual,validateMaxwellCapacitance,extractCapacitance} from '../src/routed-extraction.mjs'
import {generalDeclarations} from '../src/declarations.mjs'
import {sampleAtCrossings,waveformDifference} from '../src/comparison.mjs'

const project=fileURLToPath(new URL('../../..',import.meta.url))

test('capacitance checks reject nonphysical coupling even when a large reference diagonal hides it',()=>{
  assert.doesNotThrow(()=>validateMaxwellCapacitance([[2,-.2,-1],[-.2,2,-1],[-1,-1,3]]))
  assert.throws(()=>validateMaxwellCapacitance([[1,-.01,-.5],[-.15,1,-.5],[-.5,-.5,100]]),/pair-normalized/)
  assert.throws(()=>validateMaxwellCapacitance([[1,.1,-.5],[.1,1,-.5],[-.5,-.5,100]]),/negative mutual/)
  assert.doesNotThrow(()=>validateMaxwellCapacitance([[1,0,-.5],[0,1,-.5],[-.5,-.5,2]]),'perfectly shielded pairs can have exactly zero mutual capacitance')
})

const correctionPolicy={maximumEnergyFraction:.001,maximumWaveformDifferenceV:.001}

test('explicit Maxwell correction preserves row sums and reports a conservative energy bound without changing native data',()=>{
  const native=[[1,.0001,-.5],[.0001,1,-.5],[-.5,-.5,2]],saved=structuredClone(native)
  const checked=validateMaxwellCapacitance(native,.02,correctionPolicy),report=checked.capacitanceCorrection
  assert.deepEqual(native,saved)
  assert.deepEqual(report.rawMatrix,saved);assert.deepEqual(report.symmetricMatrix,saved)
  assert.deepEqual(report.projectedMatrix,checked.matrix)
  assert.equal(report.correctedPairs.length,1);assert.equal(report.rawMaximumPositiveMutualF,.0001)
  assert.equal(checked.matrix[0][1],0);assert.equal(checked.matrix[1][0],0)
  for(let i=0;i<native.length;i++) {
    assert.ok(Math.abs(native[i].reduce((a,b)=>a+b,0)-checked.matrix[i].reduce((a,b)=>a+b,0))<1e-14)
    assert.ok(Math.abs(report.correctionMatrix[i].reduce((a,b)=>a+b,0))<1e-14)
  }
  // This symmetric fixture's correction has one generalized eigenvalue: 2a/(1-a).
  const exactFraction=.0002/.9999
  assert.ok(Math.abs(report.conservativeMaximumEnergyFraction-exactFraction)<1e-15)
  assert.ok(report.conservativeMaximumEnergyFraction<correctionPolicy.maximumEnergyFraction)
  for(const v of [[1,0,0],[1,-1,0],[1,1,1],[2,-3,4]]) {
    const energy=m=>v.reduce((total,x,i)=>total+x*m[i].reduce((sum,y,j)=>sum+y*v[j],0),0)
    assert.ok(energy(report.correctionMatrix)>=-1e-14)
    assert.ok(energy(report.correctionMatrix)<=report.conservativeMaximumEnergyFraction*energy(report.symmetricMatrix)+1e-14)
  }
  const valid=validateMaxwellCapacitance([[2,-.2,-1],[-.2,2,-1],[-1,-1,3]],.02,correctionPolicy)
  assert.deepEqual(valid.matrix,valid.capacitanceCorrection.rawMatrix)
  assert.equal(valid.capacitanceCorrection.correctedPairs.length,0)
  assert.equal(valid.capacitanceCorrection.conservativeMaximumEnergyFraction,0)
})

test('explicit correction cannot rescue excessive energy changes, nonpositive row sums, asymmetry or an indefinite native matrix',()=>{
  const weak=[[1,.0001,-.5],[.0001,1,-.5],[-.5,-.5,2]]
  assert.throws(()=>validateMaxwellCapacitance(weak,.02,{...correctionPolicy,maximumEnergyFraction:.0001}),error=>error.code==='routed_capacitance'&&error.capacitanceCorrection.conservativeMaximumEnergyFraction>.0001)
  assert.throws(()=>validateMaxwellCapacitance([[1,.0001,-1.1],[.0001,1,-.5],[-1.1,-.5,3]],.02,correctionPolicy),/positive raw and symmetric row/)
  assert.throws(()=>validateMaxwellCapacitance([[1,.0001,-.5],[.1,1,-.5],[-.5,-.5,100]],.02,correctionPolicy),/pair-normalized/)
  assert.throws(()=>validateMaxwellCapacitance([[1,2],[2,1]],.02,correctionPolicy),/nonpositive Cholesky/)
  for(const invalid of [null,{}, {...correctionPolicy,maximumEnergyFraction:1},{...correctionPolicy,maximumWaveformDifferenceV:0}]) assert.throws(()=>validateMaxwellCapacitance(weak,.02,invalid),/capacitanceCorrection requires/)
})

test('native refinement compares raw matrices even when their explicitly corrected networks are identical',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'routed-cap-refinement-'))
  const first=[[1,.0001,-.5],[.0001,1,-.5],[-.5,-.5,2]],second=[[.9999,.0002,-.5],[.0002,.9999,-.5],[-.5,-.5,2]]
  try {
    const executable=join(folder,'fixture-solver.mjs')
    await writeFile(executable,`#!${process.execPath}\nconst args=process.argv.slice(2);if(!args.includes('-g'))process.exit(2);const matrix=args.includes('-m1')?${JSON.stringify(first)}:${JSON.stringify(second)};process.stdout.write('Capacitance matrix is:\\nDimension 3 x 3\\n'+matrix.map((row,i)=>'g'+(i+1)+'_'+(i===2?'REF':'SIG'+i)+' '+row.join(' ')).join('\\n')+'\\n\\n');\n`)
    await chmod(executable,0o700)
    const settings={capMeshEpsilons:[1,.5,.25],capInteractionRatio:.03,capLinearTolerance:1e-6,capacitanceCorrection:correctionPolicy}
    const result=await extractCapacitance({tools:{fastercap:executable},context:{signals:[{},{}],settings},modeling:{extraction:{capTolerance:1e-5}},dir:folder})
    assert.equal(result.refinement.length,3,'identical projections must not cause premature raw convergence')
    assert.ok(result.refinement[1].refinementResidual>1e-5)
    assert.equal(result.refinement[2].refinementResidual,0)
    assert.equal(capacitanceRefinementResidual(result.refinement[0].capacitanceCorrection.projectedMatrix,result.refinement[1].capacitanceCorrection.projectedMatrix),0)
    assert.deepEqual(result.matrix,second,'the primitive native matrix remains raw')
    assert.deepEqual(result.capacitanceCorrection.rawMatrix,second)
    assert.deepEqual(JSON.parse(await readFile(join(folder,'capacitance-correction.json'),'utf8')),result.capacitanceCorrection)
    assert.deepEqual(JSON.parse(await readFile(join(folder,'capacitance-refinement.json'),'utf8')).map(item=>item.matrix),[first,second,second])
  } finally {await rm(folder,{recursive:true,force:true})}
})

test('routed experiment preserves real meanders, physical near neighbors and reference planes',async()=>{
  const entry=await loadEntry(join(project,'examples/ddr-routed/index.circuit.tsx'))
  const geometry=geometryFromCircuitJson(entry.circuitJson,entry.modeling)
  assert.equal(geometry.kind,'routed-shapes');assert.equal(geometry.mappings.length,14)
  for(const port of ['DM1','DQ9','CKE']) assert.ok(entry.modeling.lanes.some(lane=>lane.port===port),'include physical neighbors alongside DQ0, not only its byte group')
  assert.equal(geometry.cells.length,0,'no invented parallel return-strip cells')
  assert.ok(geometry.mappings.some(lane=>lane.originalRoute.some(point=>point.layer==='inner2')),'neighbor routes retain their different physical layers')
  for(const lane of geometry.mappings) {
    const source=entry.circuitJson.find(trace=>trace.type==='pcb_trace'&&trace.pcb_trace_id===lane.pcbTraceId)
    assert.deepEqual(lane.originalRoute.map(({x,y})=>[x,y]),source.route.map(({x,y})=>[x,y]),'actual routed coordinates are unchanged')
  }
  const declarations=generalDeclarations(entry.circuitJson,geometry,entry.modeling)
  assert.deepEqual(declarations.plans.map(plan=>plan.name),['QUIET','SWITCHING'])
  const victims=declarations.plans.map(plan=>plan.stimuli.find(stimulus=>stimulus.name.endsWith('_DQ0')))
  assert.deepEqual(victims[0].pattern,victims[1].pattern,'victim traffic is fixed across comparison cases')
  for(const plan of declarations.plans) {
    const enable=plan.stimuli.find(stimulus=>stimulus.name.endsWith('_CKE'))
    assert.equal(enable.pattern.bits,'1');assert.equal(enable.initial_state,1);assert.equal(enable.inverted,false,'clock enable stays high during the active-transfer test')
  }
  const folder=await mkdtemp(join(tmpdir(),'routed-physical-test-'))
  try {
    const physical=await prepareRoutedExtraction({circuitJson:entry.circuitJson,geometry,modeling:entry.modeling,out:folder})
    assert.equal(physical.signals.length,14)
    assert.deepEqual(physical.returns.map(reference=>reference.name),['GND','DDR_1V5'])
    for(const reference of physical.returns) {
      const regions=physical.model.multilayer.copper.filter(group=>group.netId===reference.from.netId).flatMap(group=>group.regions)
      assert.ok(regions.some(region=>region.isPlane&&region.holes.length>0),'saved plane voids remain present')
    }
    assert.equal(physical.model.multilayer.stackup.dielectrics.length,3)
    assert.deepEqual(JSON.parse(await readFile(join(folder,'physical-input.json'),'utf8')).signals,JSON.parse(JSON.stringify(physical.signals)))
  } finally {await rm(folder,{recursive:true,force:true})}
})

test('comparison samples actual irregular waveforms and reports wrong bits without hiding them',()=>{
  const rows=[[0,.2,-1],[.9,.2,1],[1.1,1.2,1],[1.9,1.2,-1],[2.1,.2,-1],[2.9,.2,1]]
  const settings={rows,signalColumn:1,samplingColumn:2,thresholdV:.75,startSeconds:0,endSeconds:3,stimulus:{start_time_ms:0,unit_interval_ms:1000,inverted:false,pattern:{type:'bits',bits:'010',repeat:true}}}
  const good=sampleAtCrossings(settings)
  assert.equal(good.decodedBits,3);assert.equal(good.errors,0);assert.deepEqual(good.histories,['010'])
  const bad=sampleAtCrossings({...settings,rows:rows.map(row=>row[0]>=2.1?[row[0],1.2,row[2]]:row)})
  assert.equal(bad.errors,1);assert.deepEqual(bad.histories,['011'])
  const delta=waveformDifference({quiet:[[0,0],[2,2]],active:[[.5,.6],[1,1.2],[1.5,1.4]],quietColumn:1,activeColumn:1,startSeconds:0,endSeconds:2})
  assert.ok(Math.abs(delta.peakAbsoluteV-.2)<1e-12);assert.ok(Math.abs(delta.minimumV+.1)<1e-12)
  assert.equal(capacitanceRefinementResidual([[9,-2],[-2,4]],[[10,-2],[-2,4]]),.1)
})
