import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {downloadIbisAsset,resolveAssetUrl} from '../src/asset-download.js'

const publicDns=async()=>[{address:'93.184.216.34',family:4}]
const localPolicy={allowHttp:true,testAllowLoopback:true,timeoutMs:1000}
const serve=async(t,handler)=>{
  const server=createServer(handler)
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve))})
  return `http://127.0.0.1:${server.address().port}`
}

test('download policy requires HTTPS and explicit HTTP opt-in',async()=>{
  await resolveAssetUrl('https://vendor.example/model.ibs',{},publicDns)
  await assert.rejects(resolveAssetUrl('http://vendor.example/model.ibs',{},publicDns),/HTTPS/)
  await resolveAssetUrl('http://vendor.example/model.ibs',{allowHttp:true},publicDns)
  for(const url of ['file:///etc/passwd','ftp://vendor.example/model.ibs','https://user:pass@vendor.example/model.ibs'])
    await assert.rejects(resolveAssetUrl(url,{},publicDns),/HTTPS|credentials/)
})

test('download policy rejects private, loopback, metadata and encoded IP literals',async()=>{
  for(const host of ['0.0.0.0','0.1.2.3','127.0.0.1','127.2.3.4','2130706433','0x7f000001',
    '10.1.2.3','172.16.0.1','172.31.255.255','192.168.1.2','169.254.169.254',
    '100.100.100.200','[::]','[::1]','[fc00::1]','[fdff::1]','[fe80::1]','[febf::1]',
    '[::ffff:127.0.0.1]','[::ffff:192.168.1.2]','[64:ff9b::a00:1]','[2002:7f00:1::1]','[2001::1]'])
    await assert.rejects(resolveAssetUrl(`https://${host}/model.ibs`),/disallowed/,host)
  for(const host of ['93.184.216.34','172.15.0.1','172.32.0.1','[2606:4700:4700::1111]'])
    await resolveAssetUrl(`https://${host}/model.ibs`)
})

test('download policy checks all DNS answers and exact allowlisted hostnames',async()=>{
  let resolvedHost
  const dns=async host=>{resolvedHost=host;return publicDns()}
  const result=await resolveAssetUrl('https://VENDOR.example./model.ibs',{allowedHosts:['vendor.example']},dns)
  assert.equal(resolvedHost,'vendor.example')
  assert.deepEqual(result.addresses,await publicDns())
  for(const host of ['sub.vendor.example','vendor.example.attacker.test'])
    await assert.rejects(resolveAssetUrl(`https://${host}`,{allowedHosts:['vendor.example']},publicDns),/allowlisted/)
  await assert.rejects(resolveAssetUrl('https://vendor.example',{allowedHosts:[]},publicDns),/allowlisted/)
  for(const address of ['10.0.0.1','127.0.0.1','169.254.169.254','::1','fc00::1','fe80::1']) {
    const dns=async()=>[...await publicDns(),{address,family:address.includes(':')?6:4}]
    await assert.rejects(resolveAssetUrl('https://vendor.example',{},dns),/disallowed/)
  }
  await assert.rejects(resolveAssetUrl('https://vendor.example',{},async()=>[]),/disallowed/)
  // An allowlisted host still must resolve to public addresses.
  await assert.rejects(resolveAssetUrl('https://vendor.example',{allowedHosts:['vendor.example']},async()=>[{address:'10.0.0.1',family:4}]),/disallowed/)
})

test('redirects are revalidated for scheme, host allowlist and address, with a hop limit',async t=>{
  const visited=[]
  let destination='/final'
  const base=await serve(t,(request,response)=>{
    visited.push(request.url)
    if(request.url==='/final') response.end('model bytes')
    else {response.writeHead(302,{Location:destination});response.end()}
  })
  assert.equal((await downloadIbisAsset(base+'/start',localPolicy)).toString(),'model bytes')
  assert.deepEqual(visited,['/start','/final'])
  destination='http://169.254.169.254/latest/meta-data'
  await assert.rejects(downloadIbisAsset(base+'/start',localPolicy),/disallowed/)
  destination='http://10.0.0.1/model.ibs'
  await assert.rejects(downloadIbisAsset(base+'/start',localPolicy),/disallowed/)
  destination='https://other.example/model.ibs'
  await assert.rejects(downloadIbisAsset(base+'/start',{...localPolicy,allowedHosts:['127.0.0.1']}),/allowlisted/)
  destination='file:///etc/passwd'
  await assert.rejects(downloadIbisAsset(base+'/start',localPolicy),/HTTPS/)
  destination='/start'
  await assert.rejects(downloadIbisAsset(base+'/start',localPolicy),/5 redirects/)
})

test('timeout aborts stalled headers and stalled bodies',async t=>{
  for(const withHeaders of [false,true]) {
    const base=await serve(t,(_request,response)=>{
      if(withHeaders) {response.writeHead(200);response.write('partial')}
    })
    const started=Date.now()
    await assert.rejects(downloadIbisAsset(base,{...localPolicy,timeoutMs:50}),/timed out after 50 ms/)
    assert.ok(Date.now()-started<2000)
  }
})

test('size limit rejects Content-Length before consuming an unfinished body',async t=>{
  const base=await serve(t,(_request,response)=>{
    response.writeHead(200,{'Content-Length':'1024'})
    response.flushHeaders()
  })
  await assert.rejects(downloadIbisAsset(base,{...localPolicy,maxBytes:16}),/exceeds 16 bytes/)
})

test('size limit aborts chunked bodies as soon as they exceed the limit',async t=>{
  let closed
  const disconnected=new Promise(resolve=>{closed=resolve})
  const base=await serve(t,(_request,response)=>{
    response.on('close',closed)
    response.write(Buffer.alloc(8))
    response.write(Buffer.alloc(9))
    // Deliberately never end the stream: the client must stop on size, not EOF.
  })
  await assert.rejects(downloadIbisAsset(base,{...localPolicy,maxBytes:16}),/exceeds 16 bytes/)
  await disconnected
})

test('downloads accept the exact size limit and reject HTML and HTTP errors',async t=>{
  const base=await serve(t,(request,response)=>{
    if(request.url==='/html') response.writeHead(200,{'Content-Type':'text/html'})
    if(request.url==='/missing') response.writeHead(404)
    response.end('12345678')
  })
  assert.equal((await downloadIbisAsset(base,{...localPolicy,maxBytes:8})).toString(),'12345678')
  await assert.rejects(downloadIbisAsset(base+'/html',localPolicy),/HTML/)
  await assert.rejects(downloadIbisAsset(base+'/missing',localPolicy),/HTTP 404/)
})

test('environment config sets HTTP opt-in, allowlist, timeout and byte limit',async t=>{
  const names=['PCB_SPICE_IBIS_ALLOW_HTTP','PCB_SPICE_IBIS_ALLOWED_HOSTS','PCB_SPICE_IBIS_TIMEOUT_MS','PCB_SPICE_IBIS_MAX_BYTES']
  const original=Object.fromEntries(names.map(name=>[name,process.env[name]]))
  t.after(()=>{for(const name of names) {if(original[name]===undefined) delete process.env[name];else process.env[name]=original[name]}})
  const base=await serve(t,(_request,response)=>response.end('12345678'))
  process.env.PCB_SPICE_IBIS_ALLOW_HTTP='1'
  process.env.PCB_SPICE_IBIS_ALLOWED_HOSTS='vendor.example'
  await assert.rejects(downloadIbisAsset(base,{testAllowLoopback:true}),/allowlisted/)
  process.env.PCB_SPICE_IBIS_ALLOWED_HOSTS='127.0.0.1'
  process.env.PCB_SPICE_IBIS_MAX_BYTES='7'
  await assert.rejects(downloadIbisAsset(base,{testAllowLoopback:true}),/exceeds 7 bytes/)
  process.env.PCB_SPICE_IBIS_MAX_BYTES='8'
  assert.equal((await downloadIbisAsset(base,{testAllowLoopback:true})).length,8)
  await assert.rejects(downloadIbisAsset(base,{allowHttp:false,testAllowLoopback:true}),/HTTPS/)
  process.env.PCB_SPICE_IBIS_TIMEOUT_MS='0'
  await assert.rejects(downloadIbisAsset(base,{testAllowLoopback:true}),/timeoutMs/)
  process.env.PCB_SPICE_IBIS_TIMEOUT_MS='50'
  const stalled=await serve(t,()=>{})
  await assert.rejects(downloadIbisAsset(stalled,{testAllowLoopback:true}),/timed out after 50 ms/)
  for(const maxBytes of [0,-1,1.5,NaN,Infinity])
    await assert.rejects(downloadIbisAsset(base,{...localPolicy,maxBytes}),/maxBytes/)
})
