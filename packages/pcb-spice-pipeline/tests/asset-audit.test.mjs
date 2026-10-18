import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {auditIbisSource} from '../../../scripts/verification/audit-ibis.mjs'
import {sha256} from '../../../scripts/verification/independent-helpers.mjs'

test('independent asset audit rejects coherent replacement bytes and missing declared expectations',async t=>{
  const out=await mkdtemp(join(tmpdir(),'ibis-asset-audit-'))
  t.after(()=>rm(out,{recursive:true,force:true}))
  await mkdir(join(out,'inputs/ibis'),{recursive:true})
  const asset={project_relative_path:'models/driver.ibs',url:'./models/driver.ibs',mimetype:'text/plain'}
  const original=Buffer.from('[IBIS Ver] 4.2\r\n[Comment Char] |_char\r\n[End]\r\n')
  const replacement=Buffer.from('[IBIS Ver] 4.2\r\n[Comment Char] !_char\r\n[End]\r\n')
  const ibsFile='inputs/ibis/driver.ibs'
  const evidence=bytes=>({ibisModelAsset:asset,resolvedFrom:'project',ibsFile,rawSourceFile:ibsFile,rawSourceSha256:sha256(bytes),sourceSha256:sha256(bytes)})
  const saveModeling=ibisModelAssetSha256=>writeFile(join(out,'inputs/modeling.json'),JSON.stringify({ibisModelAssetSha256}))
  const expected=sha256(original)
  await saveModeling({[asset.project_relative_path]:expected.toUpperCase()})
  await writeFile(join(out,ibsFile),original)
  const verified=await auditIbisSource(out,asset,evidence(original),original)
  assert.equal(verified.expectedHashVerified,true)
  assert.equal(verified.expectedSha256,expected)
  const uncoveredAsset={...asset,project_relative_path:'models/receiver.ibs'}
  await assert.rejects(auditIbisSource(out,uncoveredAsset,{...evidence(original),ibisModelAsset:uncoveredAsset},original),/requires a valid expected hash for models\/receiver\.ibs/)
  await writeFile(join(out,ibsFile),replacement)
  await assert.rejects(auditIbisSource(out,asset,evidence(replacement),replacement),/declared expected SHA-256/)
  await writeFile(join(out,ibsFile),original)
  await saveModeling({})
  await assert.rejects(auditIbisSource(out,asset,evidence(original),original),/requires a valid expected hash/)
  await saveModeling({[asset.project_relative_path]:'not-a-sha256'})
  await assert.rejects(auditIbisSource(out,asset,evidence(original),original),/requires a valid expected hash/)
  for(const invalid of [null,[],true]) {
    await saveModeling(invalid)
    await assert.rejects(auditIbisSource(out,asset,evidence(original),original),/must be an asset-path to SHA-256 mapping/)
  }
  await saveModeling(undefined)
  const unlocked=await auditIbisSource(out,asset,evidence(original),original)
  assert.equal(unlocked.expectedHashVerified,false)
  assert.equal(unlocked.expectedSha256,null)
})
