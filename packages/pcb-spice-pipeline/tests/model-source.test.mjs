import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,rm,symlink,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {loadModelSource} from '../src/general-pipeline.js'
import {sha256} from '../src/io.mjs'

const bytes=Buffer.from('\uFEFF[IBIS Ver] 4.2\r\n[File Name] driver.ibs\r\n[End]\r\n')
const asset={project_relative_path:'models/driver.ibs',url:'https://vendor.example/driver.ibs',mimetype:'text/plain'}
const model=ibis_model_asset=>({pipelineId:'model-0',ibis_model_asset})
const temporary=async t=>{const dir=await mkdtemp(join(tmpdir(),'pipeline-model-asset-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir}

test('project IBIS asset wins over URL and preserves exact vendor bytes',async t=>{
  const dir=await temporary(t),originalFetch=globalThis.fetch
  await mkdir(join(dir,'models'))
  await writeFile(join(dir,asset.project_relative_path),bytes)
  globalThis.fetch=async()=>{assert.fail('A present project asset must not download a different model')}
  t.after(()=>{globalThis.fetch=originalFetch})
  const loaded=await loadModelSource(model(asset),dir,join(dir,'cache'))
  assert.deepEqual(loaded.bytes,bytes)
  assert.equal(loaded.text,bytes.toString('utf8'))
  assert.deepEqual(loaded.evidence.ibisModelAsset,asset)
  assert.equal(loaded.evidence.resolvedFrom,'project')
  assert.equal(loaded.evidence.resolvedPath,await realpath(join(dir,asset.project_relative_path)))
  assert.equal(loaded.evidence.rawSourceFile,loaded.evidence.ibsFile)
  assert.equal(loaded.evidence.sourceSha256,sha256(bytes))
  assert.equal(loaded.evidence.rawSourceSha256,sha256(bytes))
})

test('missing project asset downloads its declared URL and records exact executed bytes',async t=>{
  const dir=await temporary(t),originalFetch=globalThis.fetch,requests=[]
  globalThis.fetch=async url=>{requests.push(url);return new Response(bytes,{status:200})}
  t.after(()=>{globalThis.fetch=originalFetch})
  const loaded=await loadModelSource(model(asset),dir,join(dir,'cache'))
  assert.deepEqual(requests,[asset.url])
  assert.deepEqual(loaded.bytes,bytes)
  assert.deepEqual(loaded.evidence.ibisModelAsset,asset)
  assert.equal(loaded.evidence.resolvedFrom,'url')
  assert.equal(loaded.evidence.sourceSha256,sha256(bytes))
  assert.equal(loaded.evidence.rawSourceSha256,sha256(bytes))
  globalThis.fetch=async()=>new Response('not found',{status:404})
  await assert.rejects(loadModelSource(model(asset),dir,join(dir,'cache')),/404/)
})

test('asset project path cannot escape through traversal, absolute paths or symlinks',async t=>{
  const dir=await temporary(t),root=join(dir,'project'),outside=join(dir,'outside.ibs')
  await mkdir(root)
  await writeFile(outside,bytes)
  await symlink(outside,join(root,'linked.ibs'))
  for(const project_relative_path of ['../outside.ibs',outside,'linked.ibs'])
    await assert.rejects(loadModelSource(model({...asset,project_relative_path}),root,join(dir,'cache')),/asset|project|relative|outside|escape/i)
})

test('asset loader rejects HTML, ZIP archives, invalid UTF-8 and unavailable relative URLs',async t=>{
  const dir=await temporary(t),originalFetch=globalThis.fetch
  t.after(()=>{globalThis.fetch=originalFetch})
  for(const payload of [Buffer.from('<!doctype html><title>Download</title>'),Buffer.from('PK\u0003\u0004archive'),Buffer.from([0xc3,0x28])]) {
    globalThis.fetch=async()=>new Response(payload,{status:200})
    await assert.rejects(loadModelSource(model(asset),dir,join(dir,'cache')),/IBIS|plain|ZIP|UTF|HTML|encoded/i)
  }
  await assert.rejects(loadModelSource(model({...asset,url:'./models/driver.ibs'}),dir,join(dir,'cache')),/asset|URL|http|missing/i)
})
