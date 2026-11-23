import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, writeFile, access, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay, setImmediate as tick } from 'node:timers/promises'
import { createFeishuAuth } from '../host/auth.js'

const profile='fixture', scopes=['contact:user.basic_profile:readonly','im:chat:read','im:message.group_msg:get_as_user','im:message.p2p_msg:get_as_user','search:message','im:message.send_as_user','im:message']
const loginURL='https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=sample&user_code=TEST-ONLY'
const setupURL='https://open.feishu.cn/page/cli?user_code=TEST-ONLY&lpv=1.0.100&ocv=1.0.100&from=cli'
const complete={event:'authorization_complete',user_open_id:'ou_sample',missing:[],granted:scopes}
const self={ok:true,identity:'user',data:{user:{open_id:'ou_sample',tenant_key:'tenant_sample'}}}
const code=value=>({code:value})
// CLI 1.0.100 output for a public documentation URL; contains no authorization code.
const fakePNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAQAAAAEAAQMAAABmvDolAAAABlBMVEX///8AAABVwtN+AAABmElEQVR42uyYMc6sMAyEJ6Kg5AgcJUdLjsZROEJKCpR5GhtY9Pa99tePhYtdbfi2IPFMbOONN974tTFRsU1L6cMGZPZzKRawAhgEYNgwLyVtx1IwIFM7kImBDTDAlwICE9kHcs21IzCAXDEomcMCnsLnWuG/0/7pwOVRaR+bi/c/JvZk4OIqd2Bm/ftJDEApnMiWK/dR76+sRkncngX412Jrsx3kKqHGAnSAfWBzbSppzYh0tKEAAFJlrrpWdNDajfs+hACm1R4JIxt0b8pv+12bAQAg1yTZ+qcsSIl+d9oggDyKSyHZ5LT6ERJwpXY3LBdvuok3CFCtQ9GrS7wY20xGBLrdODePWgqDAV4sKKuBUfl8/ScUIN/1Ne5W4Ca2eUE4QClMa8Rg1aCJl08DcBZ7qoVkuzbw+W5Ang18+izuowDaDORjQUGAY6LF6k1J8X2491kxgHMGkkyb9SjduUUEJlmsFXvdDv1rPhkFsKtyXlS0y2nDAddEC/bIatryJd6nA6dH4aiCvB2LBrzxxhs/Hn8CAAD//z8YAmHwZ/YNAAAAAElFTkSuQmCC','base64')

async function fixture(t,opts={}) {
  const root=await mkdtemp(join(tmpdir(),'dsh-sa-auth-test-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const cliDir=opts.shared ? undefined : join(root,'managed')
  const done=Promise.withResolvers(), calls=[]
  const run=async(args,{onLine,signal,cwd,cliDir:dir})=>{
    calls.push({args,dir,cwd})
    assert.equal(dir,cliDir)
    signal.throwIfAborted()
    const guard=()=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))
    if(args.includes('qrcode')) {
      assert.ok([opts.url || loginURL,setupURL].includes(args[2]))
      assert.deepEqual(args,['auth','qrcode',args[2],'--output','authorize.png'])
      await writeFile(join(cwd,'authorize.png'),opts.png ?? fakePNG)
      return JSON.stringify({ok:true,file_path:'/must-not-follow/foreign.png',hint:'private diagnostic'})
    }
    if(args.includes('contact')) {
      assert.deepEqual(args,['--profile',profile,'contact','+get-user','--as','user','--format','json','--jq','{ok,identity,dry_run,data:{user:(.data.user | {open_id,tenant_key})}}'])
      if(opts.selfCheck) await Promise.race([opts.selfCheck,guard()])
      return JSON.stringify(opts.self || self)
    }
    if(opts.failure) throw opts.failure
    if(args.includes('init')) {
      assert.deepEqual(args,['config','init','--new','--name',profile,'--brand','feishu'])
      onLine('stderr','scan this code');onLine('stderr',opts.url || setupURL)
      await Promise.race([guard(),done.promise])
      await writeFile(join(cliDir,'config.json'),'fixture')
      return JSON.stringify({appId:'cli_fixture',brand:'feishu',appSecret:'sensitive-fixture-marker'})
    }
    assert.deepEqual(args,['--profile',profile,'auth','login','--scope',scopes.join(' '),'--json'])
    const first=JSON.stringify({event:'device_authorization',verification_uri_complete:opts.url || loginURL,expires_in:opts.expires ?? 30,device_code:'sensitive-fixture-marker'})
    onLine('stdout',first)
    const end=await Promise.race([guard(),done.promise])
    return first+'\n'+JSON.stringify(end)+'\n'
  }
  const auth=createFeishuAuth({run,cliDir})
  t.after(()=>auth.dispose())
  const start=(kind='login')=>auth.start({kind,profile})
  return {auth,start,done,calls,cliDir,root}
}
const handle=({flowId})=>({profile,flowId})

test('authorization asks for scoped group reads and the two required user reply scopes and exposes only the official link, local PNG and handle',async t=>{
  const f=await fixture(t)
  assert.equal(f.calls.length,0)
  const step=await f.start()
  assert.deepEqual(Object.keys(step).sort(),['expiresAt','flowId','qrDataUrl','url'])
  assert.equal(step.url,loginURL)
  assert.equal(step.qrDataUrl,'data:image/png;base64,'+fakePNG.toString('base64'))
  assert.ok(!JSON.stringify(step).includes('sensitive-fixture-marker'))
  await assert.rejects(access(f.calls[1].cwd),{code:'ENOENT'})
  const h=handle(step)
  await assert.rejects(f.auth.finish(h),code('auth-pending'))
  await assert.rejects(f.start(),code('auth-busy'))
  await assert.rejects(f.auth.cancel({...h,profile:'other'}),code('auth-expired'))
  assert.equal(f.calls.length,2)
  f.done.resolve(complete);await tick()
  assert.deepEqual(await f.auth.finish(h),{kind:'login',tenantId:'tenant_sample',recipientId:'ou_sample'})
  assert.equal(f.calls.length,3)
  await assert.rejects(f.auth.finish(h),code('auth-expired'))
})

test('only explicit setup creates a new dedicated CLI profile, never an authorization or reinitialization',async t=>{
  const f=await fixture(t)
  const step=await f.start('setup')
  const twin=createFeishuAuth({cliDir:f.cliDir,run:()=>assert.fail('concurrent init')})
  await assert.rejects(twin.start({profile,kind:'setup'}),code('auth-setup-locked'))
  f.done.resolve()
  let result
  for(let i=0;i<100 && !result;i++) {
    try {result=await f.auth.finish(handle(step))}
    catch(e){assert.equal(e.code,'auth-pending');await delay(2)}
  }
  assert.deepEqual(result,{kind:'setup'})
  await assert.rejects(f.start('setup'),code('auth-profile-exists'))
  assert.equal(await readFile(join(f.cliDir,'config.json'),'utf8'),'fixture')
  assert.equal(f.calls.length,2)
  const shared=await fixture(t,{shared:true})
  await assert.rejects(shared.start('setup'),code('invalid-input'))
  assert.equal(shared.calls.length,0)
})

test('existing unread/malformed config (including another CLI workspace) cannot be replaced',async t=>{
  const f=await fixture(t)
  await mkdir(join(f.cliDir,'hermes'),{recursive:true})
  await writeFile(join(f.cliDir,'hermes','config.json'),'malformed')
  await assert.rejects(f.start('setup'),code('auth-profile-exists'))
  assert.equal(f.calls.length,0)
})

test('partial grant, wrong identity, missing tenant or open ID mismatch never bind',async t=>{
  for(const [result,identity] of [[{...complete,granted:scopes.slice(0,-2)},self],[{...complete,granted:scopes.slice(1)},self],[{...complete,missing:['search:message']},self],
    [complete,{...self,dry_run:true}],[complete,{...self,identity:'bot'}],[complete,{...self,data:{user:{open_id:'ou_other',tenant_key:'tenant_sample'}}}],
    [complete,{...self,data:{user:{open_id:'ou_sample'}}}]]) {
    const f=await fixture(t,{self:identity})
    const step=await f.start()
    f.done.resolve(result);await tick()
    await assert.rejects(f.auth.finish(handle(step)),code('auth-unavailable'))
  }
})

test('untrusted URLs, credentials and invalid QR cannot escape the Host',async t=>{
  for(const url of ['https://accounts.feishu.cn.example.org/oauth/v1/device/verify?user_code=TEST',
    'https://somebody@accounts.feishu.cn/oauth/v1/device/verify?user_code=TEST',
    loginURL+'&device_code=sensitive-fixture-marker',loginURL+'#fragment',setupURL]) {
    const f=await fixture(t,{url})
    await assert.rejects(f.start(),code('auth-unavailable'))
    assert.equal(f.calls.length,1)
  }
  const f=await fixture(t,{png:Buffer.from('sensitive-fixture-marker')})
  await assert.rejects(f.start(),code('auth-unavailable'))
  await assert.rejects(access(f.calls[1].cwd),{code:'ENOENT'})
  const bad=await fixture(t,{failure:new Error('sensitive-fixture-marker')})
  await assert.rejects(bad.start(),e=>e.code==='auth-unavailable' && !JSON.stringify(e.stack).includes('sensitive-fixture-marker'))
})

test('cancel, expiry, denial and unload consume the handle; cancelled setup may retry',async t=>{
  const f=await fixture(t,{expires:1})
  const expired=await f.start()
  await delay(1050)
  await assert.rejects(f.auth.finish(handle(expired)),code('auth-expired'))
  const setup=await f.start('setup')
  await f.auth.cancel(handle(setup))
  const retry=await f.start('setup')
  await f.auth.cancel(handle(retry))
  const login=await f.start()
  f.done.reject(Object.assign(new Error('sensitive-fixture-marker'),{code:'auth-denied'}));await tick()
  await assert.rejects(f.auth.finish(handle(login)),code('auth-denied'))
  await f.auth.dispose()
  await assert.rejects(f.start(),code('auth-unavailable'))
})

test('disposing during identity check cannot complete a stale binding',async t=>{
  const f=await fixture(t,{selfCheck:new Promise(()=>{})})
  const step=await f.start()
  f.done.resolve(complete);await tick()
  const verifying=f.auth.finish(handle(step))
  await f.auth.dispose()
  await assert.rejects(verifying,code('auth-expired'))
})

test('real process wrapper bounds stderr, classifies typed failures and kills waiting descendants', {skip:process.platform==='win32'},async t=>{
  const root=await mkdtemp(join(tmpdir(),'dsh-auth-stub-'))
  const prior=process.env.PATH, control=join(root,'control'), pidPath=join(root,'pid')
  t.after(()=>{process.env.PATH=prior;return rm(root,{recursive:true,force:true})})
  const body=`#!${process.execPath}
const fs=require('node:fs'),{spawn}=require('node:child_process');
const args=process.argv.slice(2);
if(args.includes('qrcode')){
 fs.writeFileSync('authorize.png',Buffer.from('${fakePNG.toString('base64')}','base64'));console.log('{"ok":true}');
} else {
 const mode=fs.readFileSync(${JSON.stringify(control)},'utf8');
 if(mode==='flood'){process.stderr.write('x'.repeat(160000));setInterval(()=>{},1000)}
 else if(mode==='missing'){console.error(JSON.stringify({error:{subtype:'not_configured',hint:'sensitive-fixture-marker'}}));process.exitCode=1}
 else {
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});
 fs.writeFileSync(${JSON.stringify(pidPath)},String(child.pid));console.log(JSON.stringify({event:'device_authorization',verification_uri_complete:${JSON.stringify(loginURL)},expires_in:30}));
 }
}
`
  await writeFile(join(root,'lark-cli'),body,{mode:0o700})
  process.env.PATH=root+':'+prior
  const auth=createFeishuAuth({cliDir:join(root,'cli')})
  t.after(()=>auth.dispose())
  await writeFile(control,'missing')
  await assert.rejects(auth.start({profile,kind:'login'}),code('auth-profile-missing'))
  await writeFile(control,'flood')
  await assert.rejects(auth.start({profile,kind:'login'}),code('auth-unavailable'))
  await writeFile(control,'hold')
  const step=await auth.start({profile,kind:'login'}), pid=Number(await readFile(pidPath,'utf8'))
  process.kill(pid,0)
  await auth.cancel(handle(step))
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'})
})
