import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {runtimePaths} from '../src/runtime.mjs'
import {channelSpice} from '../src/spice.mjs'
import {generalSimulationSpice} from '../src/general-spice.mjs'
import {runCapacitanceSensitivity} from '../src/capacitance-sensitivity.mjs'
import {probeWaveformRows} from '../src/metrics.mjs'
import {command,sha256} from '../src/io.mjs'
import {validateMatrix} from '../src/matrices.mjs'

test('signed branch capacitors reproduce the full SPD nodal capacitance in a native AC solve',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'signed-capacitance-'))
  try {
    const {tools}=await runtimePaths({projectDir:fileURLToPath(new URL('../../..',import.meta.url))})
    const C=[[2e-12,.2e-12],[.2e-12,3e-12]],f=1e8,stage={R:[[1,0],[0,1]],L:[[2e-8,0],[0,2e-8]],C}
    validateMatrix(C,'signed-capacitor SPD fixture')
    const channel=channelSpice([stage],1)
    assert.match(channel,/CM0a0_1 IN0 IN1 -1e-13/)
    for(let input=0;input<2;input++) {
      const deck=['Signed SPD capacitance calibration',`VA a 0 AC ${Number(input===0)}`,`VB b 0 AC ${Number(input===1)}`,channel,'XCHAN a b a b 0 CHANNEL','.control','set wr_singlescale','set wr_vecnames','set numdgt=17',`ac lin 1 ${f} ${f}`,`wrdata current${input}.dat i(VA) i(VB)`,'quit','.endc','.end',''].join('\n')
      await writeFile(join(dir,'simulation.cir'),deck)
      await command(tools.ngspice,['-b','simulation.cir'],dir,`ngspice-${input}`)
      const values=(await readFile(join(dir,`current${input}.dat`),'utf8')).trim().split(/\r?\n/)[1].trim().split(/\s+/).map(Number)
      assert.equal(values.length,5)
      for(let row=0;row<2;row++) assert.ok(Math.abs(-values[2+2*row]/(2*Math.PI*f)/C[row][input]-1)<1e-10,'native AC source charge current reconstructs every signed capacitance entry')
    }
  } finally {await rm(dir,{recursive:true,force:true})}
})

test('native raw-capacitance sensitivity stores evidence and fails an exceeded explicit waveform budget',async()=>{
  const root=await mkdtemp(join(tmpdir(),'capacitance-sensitivity-'))
  try {
    const {tools}=await runtimePaths({projectDir:fileURLToPath(new URL('../../..',import.meta.url))})
    const plan={name:'sensitivity fixture',experiment:{},maxStepSeconds:2e-11,durationSeconds:4e-9,startTimeSeconds:0,probes:[{name:'receiver',simulationVoltageProbeId:'rx',signalNode:'rx',referenceNode:'0',column:1},{name:'neighbor',simulationVoltageProbeId:'neighbor',signalNode:'neighbor',referenceNode:'0',column:2}]}
    const geometry={mappings:[{from:'tx',to:'rx'},{from:'quiet',to:'neighbor'}]},nodes={node:id=>id},modeling={sections:2}
    const electrical={lines:['VDRIVE tx 0 PULSE(0 1.5 0 80p 80p 900p 2n)','RLOAD rx 0 80','RQUIET quiet 0 80','RNEIGHBOR neighbor 0 80'],activeNodes:new Set(['0','tx','rx','quiet','neighbor']),grounded:new Set(['0'])}
    const correction={policy:{maximumEnergyFraction:.2,maximumWaveformDifferenceV:1},correctedPairs:[{i:0,j:1,symmetricPositiveCoefficientF:.2e-12}],conservativeMaximumEnergyFraction:.2}
    const extracted=[{stage:0,R:[[1,0],[0,1]],L:[[2e-8,0],[0,2e-8]],C:[[2.2e-12,0],[0,2.2e-12]],rawGroundedCapacitance:[[2e-12,.2e-12],[.2e-12,2e-12]],capacitanceCorrection:correction}]
    const physical=join(root,'physical');await mkdir(physical)
    await writeFile(join(physical,'simulation.cir'),generalSimulationSpice(plan,geometry,modeling,extracted,[],nodes,electrical))
    await command(tools.ngspice,['-b','simulation.cir'],physical,'ngspice')
    const bytes=await readFile(join(physical,'waveform.dat')),referenceRows=probeWaveformRows(bytes.toString(),plan.probes)
    const args={plan,geometry,modeling,extracted,models:[],nodes,electrical,tools,referenceRows}
    const result=await runCapacitanceSensitivity({...args,dir:physical})
    assert.equal(result.passed,true);assert.equal(result.numericalSolverInvocations,1)
    assert.ok(result.maximumDifferenceV>.001,'fixture has measurable effect of the explicit matrix correction')
    assert.equal(result.referenceWaveformSha256,sha256(bytes))
    assert.equal(result.probes.length,2)
    const out=join(physical,result.directory)
    for(const path of ['simulation.cir','waveform.dat','waveform.csv','bound.json','ngspice.command.json','ngspice.stdout.log','ngspice.stderr.log']) assert.equal(result.files[path],sha256(await readFile(join(out,path))))
    const rejected=join(root,'rejected');await mkdir(rejected);await writeFile(join(rejected,'waveform.dat'),bytes)
    correction.policy.maximumWaveformDifferenceV=1e-6
    await assert.rejects(runCapacitanceSensitivity({...args,dir:rejected}),/exceeding/)
    assert.equal(JSON.parse(await readFile(join(rejected,'numerical-capacitance-sensitivity/receipt.json'))).passed,false,'failed budget retains reviewable evidence')
  } finally {await rm(root,{recursive:true,force:true})}
})
