import test from 'node:test'
import assert from 'node:assert/strict'
import {chmod,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {extractCapacitance} from '../src/routed-extraction.mjs'

const policy={maximumEnergyFraction:.001,maximumWaveformDifferenceV:.001}
const coarse=[[1,.0006,-.5],[.0006,1,-.5],[-.5,-.5,2]]
const fine=[[1,.0004,-.5],[.0004,1,-.5],[-.5,-.5,2]]
const strict=[[1,-.0004,-.5],[-.0004,1,-.5],[-.5,-.5,2]]

async function fixture(t,matrices,overrides={}) {
  const dir=await mkdtemp(join(tmpdir(),'cap-refinement-'))
  t.after(()=>rm(dir,{recursive:true,force:true}))
  const settings={capMeshEpsilons:[1,.5,.25],capInteractionRatio:.03,capLinearTolerance:1e-6,capacitanceCorrection:policy,...overrides}
  const executable=join(dir,'fixture.mjs')
  await writeFile(executable,`#!${process.execPath}\nconst args=process.argv.slice(2);if(!args.includes('-g'))process.exit(2);const index=${JSON.stringify(settings.capMeshEpsilons)}.indexOf(Number(args.find(x=>x.startsWith('-m')).slice(2)));const matrix=${JSON.stringify(matrices)}[index];process.stdout.write(typeof matrix==='string'?matrix:'Capacitance matrix is:\\nDimension 3 x 3\\n'+matrix.map((row,i)=>'g'+(i+1)+'_'+(i===2?'REF':'SIG'+i)+' '+row.join(' ')).join('\\n')+'\\n\\n');\n`)
  await chmod(executable,0o700)
  return {dir,extract:()=>extractCapacitance({tools:{fastercap:executable},context:{signals:[{},{}],settings},modeling:{extraction:{capTolerance:.02}},dir}),history:async()=>JSON.parse(await readFile(join(dir,'capacitance-refinement.json'),'utf8'))}
}

test('a correction-over-budget coarse matrix is only a raw refinement reference',async t=>{
  const f=await fixture(t,[coarse,fine])
  const result=await f.extract()
  assert.equal(result.refinement.length,2,'do not require an unnecessary third native level')
  assert.equal(result.refinement[0].status,'refinement-reference-only')
  assert.ok(result.refinement[0].capacitanceCorrection.conservativeMaximumEnergyFraction>policy.maximumEnergyFraction)
  assert.deepEqual(result.refinement[0].matrix,coarse)
  assert.equal(result.refinement[1].refinementReferenceLabel,'fastercap-0')
  assert.ok(Math.abs(result.refinement[1].refinementResidual-.0002)<1e-15)
  assert.deepEqual(result.matrix,fine,'only the finer policy-valid matrix is returned')
  assert.deepEqual(result.capacitanceCorrection.policy,policy)
  assert.ok(result.capacitanceCorrection.conservativeMaximumEnergyFraction<policy.maximumEnergyFraction)
  assert.deepEqual(JSON.parse(await readFile(join(f.dir,'capacitance-correction.json'),'utf8')).rawMatrix,fine)
})

test('other failed native or raw-matrix checks cannot supply a refinement reference',async t=>{
  const cases=[
    ['native nonconvergence','not converging'],
    ['indefinite raw matrix',[[1,2,0],[2,1,0],[0,0,2]]],
    ['nonpositive raw row sums',[[1,.0001,-1.1],[.0001,1,-.5],[-1.1,-.5,3]]],
    ['pair reciprocity',[[1,.0001,-.5],[.1,1,-.5],[-.5,-.5,100]]],
    ['nonfinite correction calculation',[[1e-320,1e-323,0],[1e-323,1e-320,0],[0,0,2e-320]]],
    ['positive mutual without optional policy',coarse,{capacitanceCorrection:undefined}],
  ]
  for(const [name,matrix,settings] of cases) await t.test(name,async t=>{
    const f=await fixture(t,[matrix,strict,strict],settings)
    const result=await f.extract()
    assert.equal(result.refinement.length,3)
    assert.notEqual(result.refinement[0].status,'refinement-reference-only')
    assert.equal(result.refinement[1].refinementResidual,null)
    assert.equal(result.refinement[1].refinementReferenceLabel,null)
    assert.equal(result.refinement[2].refinementReferenceLabel,'fastercap-1')
    assert.deepEqual(result.matrix,strict)
  })
})

test('raw convergence never permits an over-budget final electrical model',async t=>{
  const f=await fixture(t,[coarse,coarse],{capMeshEpsilons:[1,.5]})
  await assert.rejects(f.extract(),error=>error.code==='cap_convergence')
  assert.deepEqual((await f.history()).map(item=>item.status),['refinement-reference-only','refinement-reference-only'])
  await assert.rejects(readFile(join(f.dir,'capacitance-correction.json')),error=>error.code==='ENOENT')
})
