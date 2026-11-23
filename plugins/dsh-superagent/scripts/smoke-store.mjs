// Run with the installed Desktop Electron in Node mode, not against the user's profile.
import { createRequire } from 'node:module'
import { mkdtemp,realpath,rm,writeFile,readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join,dirname,basename } from 'node:path'
import assert from 'node:assert/strict'
import { openStore } from '../host/store.js'
import { createAdmission } from '../host/admission.js'

const root=process.env.DSH_TEST_RUNTIME || '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh'
const require=createRequire(join(root,'package.json'))
const {DomainFacility}=require('@deepseek-ai/dsh-storage-domain')
const {JsonStorageBackend}=require('@deepseek-ai/dsh-storage-json')
const temp=await realpath(tmpdir()),scratch=await mkdtemp(join(temp,'dsh-superagent-storage-'))
async function checkUpgrade(version) {
  const scope={profile:'isolated',tenantId:'tenant_test',recipientId:'ou_test'}
  const key='admission-'+createHash('sha256').update(JSON.stringify(['tenant_test','ou_test','isolated'])).digest('hex')
  const topic={chatId:'oc_test',threadId:'om_root'}
  const consentSince=1000+version, ref={...topic,messageId:'om_mention',at:1100}
  const body={...ref,text:'synthetic private body '+version}, trigger={threadId:topic.threadId,messageId:ref.messageId,at:ref.at}
  const groups=[{chatId:topic.chatId,mode:'pending',...(version>=2?{threadId:topic.threadId}:{}),...(version>=4?{triggers:[trigger]}:{})},
    {chatId:'oc_once',mode:'once',threadId:'om_old',...(version>=3?{approvedAt:700,grantId:'9d596d43-6f2c-42b0-9db5-b7975ed29f99'}:{})},
    {chatId:'oc_perm',mode:'permanent'}]
  const scan={since:1010,until:1200,pageToken:'page-two'}
  const file=join(scratch,'pcmid_superagent.json')
  const workspace={schema:1,team:{lead:'old',develop:'',answer:''},roleModels:{},cases:[]}
  await writeFile(file,JSON.stringify({unit:{name:'pcmid_superagent',version},global:null,tables:{
    workspace:{cases:workspace},admission:{[key]:{key,groups,...(version>=4?{consentSince}:{})}},
    ...(version>=3 ? {automation:{loop:{schema:1,jobs:[{status:'delivered'}]}}} : {}),
  }}))
  let approved
  const diagnostic={at:1501,stage:'history',reason:'invalid-response'}
  for (let pass=0;pass<3;pass++) {
    const backend=new JsonStorageBackend(scratch),ctx={emit(){},logger:{warn(){},error(){}},storage:{backend:{get:()=>backend}}}
    const facility=new DomainFacility(ctx,{backend:'json'})
    if (pass===1) await assert.rejects(openStore({open:spec=>facility.open({...spec,version:7,compatibleVersions:[]})}),{code:'version-mismatch'})
    const opened=[]
    const store=await openStore({open:s=>{opened.push(s.name);return facility.open(s)}})
    try {
      const access=createAdmission({scope,...store.permissions,consentSince,now:()=>1500})
      if (version>=3) assert.deepEqual(store.automationStore.load(),{schema:1,jobs:[{status:'delivered'}]})
      if (!pass) {
        assert.deepEqual(store.state.load(),workspace)
        assert.deepEqual(await access.list(),groups)
        assert.equal(await access.run({chatId:'oc_perm'},g=>g.mode),'permanent')
        assert.equal(JSON.parse(await readFile(file,'utf8')).unit.version,version)
        assert.deepEqual(opened,['pcmid_superagent'])
        assert.deepEqual(await access.recordMention(body,consentSince),{changed:true})
        assert.match(opened[1],/^pcmid_superagent_mentions_[a-f0-9]{64}$/)
        assert.equal((await readFile(file,'utf8')).includes(body.text),false)
        assert.deepEqual(await access.observe(ref,consentSince),{changed:version<4})
        await access.setScan(consentSince,scan)
        await store.state.save({...workspace,team:{...workspace.team,lead:'helper'}})
      } else if (pass===1) {
        assert.deepEqual(await access.list(),[{...topic,mode:'pending',triggers:[trigger]},...groups.slice(1)])
        assert.deepEqual(await access.getScan(consentSince),scan)
        assert.equal(store.state.load().team.lead,'helper')
        assert.deepEqual(opened,['pcmid_superagent'],'settings and scan access never open a body domain')
        assert.deepEqual(await access.listMentions(consentSince),[{...body,canApprove:true}])
        approved=await access.update({action:'once',...topic,messageId:ref.messageId})
        assert.equal(approved[0].approvedAt,1500)
        assert.ok(approved[0].grantId)
        await access.settleIntake(approved[0],ref,diagnostic)
      } else {
        const [pendingRetry]=await access.list()
        assert.deepEqual(pendingRetry.failures,[{...trigger,diagnostic}])
        await access.settleIntake(pendingRetry,ref)
        approved[0].triggers[0].handled=true
        assert.deepEqual(await access.list(),approved)
        assert.deepEqual(await access.run(topic,grant=>grant),approved[0])
        assert.deepEqual(approved.slice(1),groups.slice(1))
        assert.deepEqual(await access.getScan(consentSince),scan)
        assert.equal(await access.ackTrigger({...topic,messageId:ref.messageId,grantId:approved[0].grantId}),false)
        assert.equal((await access.list())[0].triggers[0].handled,true)
        assert.deepEqual(opened,['pcmid_superagent'])
        const other=createAdmission({scope:{...scope,managed:true},...store.permissions,consentSince})
        assert.deepEqual(await other.listMentions(consentSince),[])
        assert.deepEqual(await access.getMention(ref,consentSince),body)
        assert.equal(opened.length,3);assert.notEqual(opened[1],opened[2])
        assert.equal((await readFile(file,'utf8')).includes(body.text),false)
      }
    } finally {await store.close();await backend.close()}
  }
}

try {
  for (const version of [1,2,3,4,5,6,7]) await checkUpgrade(version)
  console.log('Native storage: v1–v7 metadata migrated to v8; body-free retry locations and isolated archives survive reopen; downgrade refused.')
} finally {
  assert.equal(await realpath(scratch),scratch);assert.equal(dirname(scratch),temp)
  assert.ok(basename(scratch).startsWith('dsh-superagent-storage-'))
  await rm(scratch,{recursive:true})
}
