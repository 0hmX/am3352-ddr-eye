import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readdir,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {zipSync} from 'fflate'
import {loadModelSource} from '../src/general-pipeline.js'
import {sha256} from '../src/io.mjs'

const first=Buffer.from('\uFEFF[IBIS Ver] 4.2\r\n[File Name] first.ibs\r\n[End]\r\n')
const second=Buffer.from('[IBIS Ver] 4.2\n[File Name] second.ibs\n[End]\n')
const archive=Buffer.from(zipSync({'models/first.ibs':first,'models/second.ibs':second}))
const model=source=>({pipelineId:'model-0',source})
const temporary=async t=>{const dir=await mkdtemp(join(tmpdir(),'pipeline-model-source-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir}
const source=(member='models/first.ibs',bytes=first)=>({url:'https://vendor.example/models.zip',sha256:sha256(archive),archive:{member,memberSha256:sha256(bytes)}})

test('raw ZIP cache is shared across members and revalidates raw and member checksums',async t=>{
  const dir=await temporary(t),cache=join(dir,'cache'),originalFetch=globalThis.fetch
  let downloads=0
  globalThis.fetch=async()=>{downloads++;return new Response(archive,{status:200})}
  t.after(()=>{globalThis.fetch=originalFetch})
  const a=await loadModelSource(model(source()),dir,cache)
  assert.deepEqual(a.bytes,first);assert.deepEqual(a.archive,archive)
  assert.equal(a.evidence.rawSourceFile,'inputs/ibis/model-0.zip')
  assert.equal(a.evidence.rawSourceSha256,sha256(archive))
  assert.equal(a.evidence.archiveSha256,sha256(archive))
  assert.equal(a.evidence.sourceSha256,sha256(first))
  const b=await loadModelSource(model(source('models/second.ibs',second)),dir,cache)
  assert.deepEqual(b.bytes,second);assert.equal(downloads,1)
  await assert.rejects(loadModelSource(model(source('models/first.ibs',second)),dir,cache),/member.*SHA-256/i)
  await assert.rejects(loadModelSource(model(source('missing.ibs')),dir,cache),/member.*missing/i)
  assert.equal(downloads,1,'member errors cannot bypass or redownload verified cached raw bytes')
  const files=await readdir(cache);assert.equal(files.length,1)
  await writeFile(join(cache,files[0]),Buffer.from('corrupted raw ZIP bytes'))
  await assert.rejects(loadModelSource(model(source()),dir,cache),/cached raw source bytes.*source\.sha256/i)
  assert.equal(downloads,1,'corrupt cached payload fails validation')
})

test('wrong raw download hash is rejected before caching and the obsolete archive.sha256 is rejected',async t=>{
  const dir=await temporary(t),cache=join(dir,'cache'),originalFetch=globalThis.fetch
  globalThis.fetch=async()=>new Response(archive,{status:200})
  t.after(()=>{globalThis.fetch=originalFetch})
  await assert.rejects(loadModelSource(model({...source(),sha256:sha256(first)}),dir,cache),/raw source bytes.*source\.sha256/i)
  assert.deepEqual(await readdir(cache),[],'a mismatched raw payload cannot populate the cache')
  const obsolete={...source(),archive:{member:'models/first.ibs',sha256:sha256(archive)}}
  await assert.rejects(loadModelSource(model(obsolete),dir,cache),/archive\.sha256.*unsupported/i)
})

test('file ZIP and direct file, URL and inline sources record exact raw and extracted byte provenance',async t=>{
  const dir=await temporary(t),cache=join(dir,'cache')
  await writeFile(join(dir,'vendor.zip'),archive);await writeFile(join(dir,'direct.ibs'),first)
  const zipped=await loadModelSource(model({file:'vendor.zip',sha256:sha256(archive),archive:{member:'models/first.ibs',memberSha256:sha256(first)}}),dir,cache)
  assert.deepEqual(zipped.bytes,first);assert.deepEqual(zipped.archive,archive)
  assert.equal(zipped.evidence.rawSourceSha256,sha256(archive))
  assert.equal(zipped.evidence.sourceSha256,sha256(first))
  await assert.rejects(loadModelSource(model({file:'vendor.zip',sha256:sha256(first),archive:{member:'models/first.ibs'}}),dir,cache),/original source bytes.*SHA-256/i)
  const originalFetch=globalThis.fetch
  globalThis.fetch=async()=>new Response(first,{status:200})
  t.after(()=>{globalThis.fetch=originalFetch})
  for(const input of [{file:'direct.ibs',sha256:sha256(first)},{url:'https://vendor.example/direct.ibs',sha256:sha256(first)},{content:first.toString('utf8'),sha256:sha256(first)}]) {
    const loaded=await loadModelSource(model(input),dir,cache)
    assert.deepEqual(loaded.bytes,first)
    assert.equal(loaded.archive,null)
    assert.equal(loaded.evidence.rawSourceFile,loaded.evidence.ibsFile)
    assert.equal(loaded.evidence.rawSourceSha256,sha256(first))
    assert.equal(loaded.evidence.sourceSha256,sha256(first))
    assert.equal(loaded.evidence.archiveFile,null)
    assert.equal(loaded.evidence.archiveSha256,null)
  }
})
