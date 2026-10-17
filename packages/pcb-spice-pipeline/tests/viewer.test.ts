import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {writeViewerData} from '../src/viewer.js'

test('portable results retain raw adaptive samples and escape embedded names',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'pcb-viewer-'));t.after(()=>rm(directory,{recursive:true,force:true}))
  const path=join(directory,'results.html'),name='</script><script>throw Error("untrusted")</script>'
  const data={runs:[{name,rows:[[0,0],[.17,5],[1,1]],probes:[{name:'P',column:1}],eyes:[]}],limitations:['finite model']}
  await writeViewerData(path,data,name)
  const html=await readFile(path,'utf8')
  assert.ok(!html.includes(name),'untrusted names cannot break out of an HTML or script element')
  const serialized=html.match(/id="simulation-data">([\s\S]*?)<\/script>/)![1]
  assert.deepEqual(JSON.parse(serialized),data,'full sample timestamps and values are preserved')
  assert.doesNotMatch(html,/<script[^>]+src=|https?:\/\//,'viewer needs no network resources')
})
