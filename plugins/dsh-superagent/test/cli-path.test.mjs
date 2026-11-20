import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createFeishuAuth } from '../host/auth.js'
import { createFeishuSource } from '../host/feishu.js'

const profile='fixture', tenantId='tenant', recipientId='ou_fixture', chatId='oc_fixture', messageId='om_fixture'
const config={enabled:true,profile,tenantId,recipientId,automationSince:1}
const delivery={source:{kind:'feishu',tenantId,recipientId,chatId,threadId:messageId},messageId,text:'offline',idempotencyKey:'fixture'}
const source=(cliPath,cliDir)=>createFeishuSource({cliDir,config:{...config,cliPath},admission:{run:(_,fn)=>fn({approvedAt:1})}})
const posix={skip:process.platform==='win32'}

// Both executables are local fixtures. Even a regression to always using PATH cannot run a real CLI.
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'superagent-path-')), log=join(root,'calls')
  const pathDir=join(root,'PATH'), configuredDir=join(root,'custom CLI; no shell'), cliDir=join(root,'profile')
  await Promise.all([mkdir(pathDir),mkdir(configuredDir),writeFile(log,'')])
  const script=`#!${process.execPath}
const fs=require('node:fs'), argv=process.argv.slice(2), op=argv[0]==='--profile' ? argv[3] : argv[1]
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify([process.argv[1],op])+'\\n')
const emit=x=>console.log(JSON.stringify(x)), ok=data=>emit({ok:true,identity:'user',data})
const granted=()=>argv[argv.indexOf('--scope')+1].split(' ')
switch(op) {
 case 'init': console.error('https://open.feishu.cn/page/cli?user_code=fixture'); emit({appId:'cli_fixture',brand:'feishu'});break
 case 'login':
  emit({event:'device_authorization',expires_in:60,verification_uri_complete:'https://accounts.feishu.cn/oauth/v1/device/verify?user_code=fixture'})
  emit({event:'authorization_complete',user_open_id:'ou_fixture',missing:[],granted:granted()});break
 case 'qrcode':
  // Solid black 256px PNG, not an actual authorization code.
  fs.writeFileSync('authorize.png',Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAQAAAAEAAQAAAAB0CZXLAAAAH0lEQVR4nO3BAQ0AAADCoPdPbQ43oAAAAAAAAAAAvg0hAAAB8Wch7gAAAABJRU5ErkJggg==','base64'));emit({ok:true});break
 case '+get-user': ok({user:{tenant_key:'tenant',open_id:'ou_fixture'}});break
 case 'chats': ok({chat_mode:'group',external:false,tenant_key:'tenant'});break
 case 'check': emit({ok:true,granted:granted(),missing:[]});break
 case 'POST': ok({items:[],has_more:false});break
 case 'GET': ok({items:[{chat_id:'oc_fixture',message_id:'om_fixture',create_time:'2',deleted:false,msg_type:'text',
  sender:{id_type:'open_id',id:'ou_sender',sender_type:'user',tenant_key:'tenant'},
  mentions:[{id_type:'open_id',id:'ou_fixture',tenant_key:'tenant'}],body:{content:'{"text":"fixture"}'}}]});break
 case '+messages-reply': ok({chat_id:'oc_fixture',message_id:'om_receipt'});break
 default: process.exitCode=1
}`
  const system=join(pathDir,'lark-cli'), configured=join(configuredDir,'lark-cli')
  await Promise.all([configured,system].map(file=>writeFile(file,script,{mode:0o700})))
  const prior=process.env.PATH
  process.env.PATH=pathDir
  t.after(async()=>{process.env.PATH=prior;await rm(root,{recursive:true,force:true})})
  return {system,configured,cliDir,missing:join(root,'missing','lark-cli'),
    calls:async()=> (await readFile(log,'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line))}
}

async function finish(auth,{flowId}) {
  for(let i=0;;i++) {
    try {return await auth.finish({profile,flowId})}
    catch(e) {if(e.code!=='auth-pending' || i>=100) throw e; await delay(10)}
  }
}

for(const configured of [true,false]) test(configured ? 'auth and messaging execute the configured absolute path' :
  'empty executable uses lark-cli from PATH for auth and messaging',posix,async t=>{
  const f=await fixture(t), cliPath=configured ? f.configured : '', expected=configured ? f.configured : f.system
  const auth=createFeishuAuth({cliPath,cliDir:f.cliDir})
  try {
    assert.deepEqual(await finish(auth,await auth.start({profile,kind:'setup'})),{kind:'setup'})
    assert.deepEqual(await finish(auth,await auth.start({profile,kind:'login'})),{kind:'login',tenantId,recipientId})
    const adapter=source(cliPath,f.cliDir)
    assert.deepEqual(await adapter.discover({since:1,until:2}),{mentions:[]})
    assert.equal((await adapter.reply(delivery)).messageId,'om_receipt')
    const ops=['init','qrcode','login','qrcode','+get-user','+get-user','check','POST','POST','+get-user','chats','check','GET','+messages-reply']
    assert.deepEqual(await f.calls(),ops.map(op=>[expected,op]))
  } finally {await auth.dispose()}
})

test('missing configured executable never retries with the working PATH executable',posix,async t=>{
  const f=await fixture(t), auth=createFeishuAuth({cliPath:f.missing,cliDir:f.cliDir})
  try {
    await assert.rejects(auth.start({profile,kind:'login'}),{code:'auth-unavailable'})
    await assert.rejects(source(f.missing,f.cliDir).reply(delivery),{code:'source-unavailable'})
    assert.deepEqual(await f.calls(),[])
  } finally {await auth.dispose()}
})
