import assert from 'node:assert/strict'
import test from 'node:test'
import { createAdmission } from '../host/admission.js'

const scope = { tenantId: 'tenant-a', recipientId: 'ou_testperson', profile: 'profile-a' }
const chatId = 'oc_testA'
const topic = { chatId, threadId: 'om_testA' }
const hit = () => 'read'

function memory() {
  const records = new Map(), feeds = new Map()
  return {
    records,
    mentions(feed) {
      if (!feeds.has(feed)) feeds.set(feed,new Map())
      const table = feeds.get(feed)
      return {get:id=>table.get(id),put:(id,m)=>table.set(id,m),entries:()=>table.entries()}
    },
    load: key => records.get(key),
    save: (key, record) => records.set(key, record),
  }
}

test('private opt-in has its own scan and only the current epoch may read or approve',async()=>{
  const db=memory(),consentSince=100
  let epoch=200
  const open=()=>createAdmission({...db,scope,consentSince,privateEpoch:()=>epoch,now:()=>300})
  const a=open(), group={chatId:'oc_group',threadId:'om_group'}
  const ref={...topic,messageId:'om_dm',at:250,privatePeerId:'ou_peer',privateChatsSince:200}
  const body={...ref,text:'peer request'}
  await a.update({action:'register',...group});await a.update({action:'permanent',...group})
  await a.setScan(consentSince,{since:120})
  await a.setPrivateScan(epoch,{since:210,until:250,pageToken:'more'})
  assert.deepEqual(await open().getPrivateScan(epoch),{since:210,until:250,pageToken:'more'})
  assert.deepEqual(await a.recordMention(body,consentSince),{changed:true})
  await a.observe(ref,consentSince)
  const grants=await a.update({action:'once',...topic,messageId:ref.messageId})
  assert.equal(grants.find(g=>g.chatId===chatId).privatePeerId,ref.privatePeerId)
  assert.equal(await a.run(topic,g=>g.privateChatsSince),epoch)
  await a.settleIntake(grants.find(g=>g.chatId===chatId),ref,{at:350,stage:'history',reason:'invalid-response'})
  assert.equal((await a.listMentions(consentSince))[0].intakeFailure.stage,'history')
  epoch=undefined
  assert.equal((await a.listMentions(consentSince))[0].intakeFailure,undefined)
  await assert.rejects(a.run(topic,hit),{code:'admission-denied'})
  assert.equal(await a.getMention(ref,consentSince),null)
  assert.equal((await a.listMentions(consentSince))[0].canApprove,false)
  await assert.rejects(a.setPrivateScan(200,{since:220}),{code:'scope-changed'})
  epoch=400
  assert.equal(await open().getPrivateScan(epoch),undefined)
  assert.equal(await a.getMention(ref,consentSince),null)
  assert.deepEqual(await a.observe(ref,consentSince),{changed:false})
  assert.deepEqual(await a.getScan(consentSince),{since:120})
  assert.equal(await a.run(group,hit),'read')
  const later={...ref,privateChatsSince:epoch,at:450,messageId:'om_new'}
  await a.recordMention({...later,text:'new request'},consentSince)
  await a.observe(later,consentSince)
  await assert.rejects(a.update({action:'permanent',...topic,messageId:ref.messageId}),{code:'admission-denied'})
  const fresh=await a.update({action:'once',...topic,messageId:later.messageId})
  assert.equal(fresh.find(g=>g.chatId===chatId).privateChatsSince,400)
})

test('unknown and registered groups cannot read; registration cannot upgrade or overwrite a grant', async () => {
  const a = createAdmission({ ...memory(), scope })
  let reads = 0
  assert.deepEqual(await a.list(), [])
  await assert.rejects(a.run(topic, () => reads++), { code: 'admission-denied' })
  await assert.rejects(a.update({ action: 'permanent', chatId }), { code: 'admission-denied' })
  const pending = [{ chatId, mode: 'pending' }]
  await assert.rejects(a.update({ action: 'register', chatId, mode: 'permanent' }), { code: 'invalid-input' })
  assert.deepEqual(await a.update({ action: 'register', chatId }), pending)
  await assert.rejects(a.run(topic, () => reads++), { code: 'admission-denied' })
  assert.equal(reads, 0)
  await assert.rejects(a.update({ action: 'once', ...topic }), { code: 'admission-denied' })
  await a.update({ action: 'register', ...topic })
  const approved = await a.update({ action: 'once', ...topic })
  assert.deepEqual(await a.update({ action: 'register', chatId }), approved)
})

test('one designated topic may continue after restart; other topics and the whole group remain closed', async () => {
  const db = memory()
  const first = createAdmission({ ...db, scope })
  await first.update({ action: 'register', ...topic })
  await first.update({ action: 'register', chatId: 'oc_testB' })
  await first.update({ action: 'once', ...topic })
  const a = createAdmission({ ...db, scope })
  for (const target of [{ chatId }, { ...topic, threadId: 'om_testB' }, { ...topic, chatId: 'oc_testB' }]) {
    await assert.rejects(a.run(target, hit), { code: 'admission-denied' })
  }
  assert.equal(await a.run(topic, hit), 'read')
  assert.equal(await a.run(topic, hit), 'read')
  await assert.rejects(a.update({ action: 'once', chatId, threadId: 'om_testB' }), { code: 'admission-denied' })
  assert.equal(await a.run(topic, hit), 'read')
  // Promoting to group-wide access requires a current request, not an already approved topic.
  await assert.rejects(a.update({ action:'permanent', ...topic }), {code:'admission-denied'})
  const other = {chatId,threadId:'om_other'}
  await a.update({action:'register',...other})
  await a.update({action:'permanent',...other})
  assert.equal(await a.run({ chatId }, hit), 'read')
  assert.equal(await a.run(topic, hit), 'read')
  await a.update({ action: 'revoke', chatId })
  await assert.rejects(createAdmission({ ...db, scope }).run(topic, hit), { code: 'admission-denied' })
})

test('concurrent metadata-only proposals for different topics coexist and grant no original-message exception', async () => {
  const db = memory(), a = createAdmission({ ...db, scope })
  const other = { chatId, threadId: 'om_other' }
  const denied = { code: 'admission-denied' }
  for (const extra of [{ text:'sample' }, { credentials:{} }, { mode:'permanent' }, {triggers:[]}]) {
    await assert.rejects(a.update({ action: 'register', ...topic, ...extra }), { code: 'invalid-input' })
  }
  const pending = [topic,other].map(t=>({...t,mode:'pending'}))
  const [,second] = await Promise.all([topic,other].map(t=>a.update({ action:'register', ...t })))
  assert.deepEqual(second,pending)
  for (const target of [topic,other,{chatId}]) assert.deepEqual(await a.update({ action:'register', ...target }),pending)
  assert.deepEqual(await createAdmission({ ...db, scope }).list(),pending)
  await assert.rejects(a.run(topic, hit), denied)
  await assert.rejects(a.update({ action:'permanent', chatId }), denied)
  await a.update({ action:'once', ...topic })
  await a.update({ action:'once', ...other })
  assert.equal(await a.run(topic, g=>g.triggers),undefined)
  assert.equal(await a.run(other, hit),'read')
  await a.update({ action:'revoke', ...topic })
  assert.deepEqual((await a.list()).map(g=>g.threadId),[other.threadId])
  await assert.rejects(a.run(topic, hit),denied)
  await assert.rejects(a.update({ action:'once', ...topic }),denied)
  assert.equal(await a.run(other, hit),'read')
})

test('replay keeps the persisted grant; scope change and same-millisecond reapproval create a new generation', async () => {
  const db = memory()
  let ms = 700
  const open = () => createAdmission({ ...db, scope, now: () => ms })
  const a = open()
  await a.update({ action:'register', ...topic })
  const [once] = await a.update({ action:'once', ...topic })
  assert.equal(once.approvedAt, ms)
  assert.match(once.grantId, /^[\da-f-]{36}$/)
  ms++
  await assert.rejects(open().update({ action:'once', ...topic }), {code:'admission-denied'})
  assert.deepEqual(await open().list(),[once])
  await a.run(topic, grant => {
    assert.deepEqual(grant, once)
    assert.ok(Object.isFrozen(grant))
  })
  const other = {chatId,threadId:'om_next'}
  await a.update({action:'register',...other})
  const [permanent] = await a.update({ action:'permanent', ...other })
  assert.equal(permanent.approvedAt, ms)
  assert.notEqual(permanent.grantId, once.grantId)
  await assert.rejects(a.update({ action:'permanent', chatId }), {code:'admission-denied'})
  assert.deepEqual(await a.update({ action:'revoke', chatId }), [])
  await assert.rejects(open().update({action:'permanent',chatId}),{code:'admission-denied'})
  await a.update({action:'register',chatId})
  const [reapproved] = await open().update({ action:'permanent', chatId })
  assert.equal(reapproved.approvedAt, permanent.approvedAt)
  assert.notEqual(reapproved.grantId, permanent.grantId)
  assert.deepEqual(await open().run({ chatId }, grant => grant), reapproved)
})

test('invalid clocks or caller-supplied grant metadata cannot create an effective grant', async () => {
  for (const ms of [-1, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const a = createAdmission({ ...memory(), scope, now: () => ms })
    await a.update({ action:'register', ...topic })
    await assert.rejects(a.update({ action:'once', ...topic, approvedAt:0 }), {code:'invalid-input'})
    await assert.rejects(a.update({ action:'once', ...topic }), {code:'storage-unavailable'})
    await assert.rejects(a.run(topic, hit), {code:'admission-denied'})
  }
})

test('grant storage is isolated by tenant, recipient and profile, even if a record is misrouted', async () => {
  const db = memory()
  const owner = createAdmission({ ...db, scope })
  await owner.update({ action: 'register', chatId })
  await owner.update({ action: 'permanent', chatId })
  for (const field of Object.keys(scope)) {
    const other = { ...scope, [field]: scope[field] + '-other' }
    const a = createAdmission({ ...db, scope: other })
    assert.deepEqual(await a.list(), [])
    await a.update({ action: 'register', chatId })
    await assert.rejects(a.run(topic, hit), { code: 'admission-denied' })
    const [record] = db.records.values()
    const bad = createAdmission({ ...db, scope: other, load: () => record })
    await assert.rejects(bad.run(topic, hit), { code: 'storage-unavailable' })
  }
  assert.equal(await owner.run(topic, hit), 'read')
  assert.throws(() => createAdmission({ ...db, scope: { ...scope, recipientId: '' } }), { code: 'invalid-input' })
})

test('revoke waits for a read in progress across reconstructed connectors and closes later reads', async () => {
  const db = memory(), a = createAdmission({ ...db, scope }), reopened = createAdmission({ ...db, scope })
  await a.update({ action: 'register', chatId })
  await a.update({ action: 'permanent', chatId })
  let started, release
  const entered = new Promise(resolve => { started = resolve })
  const held = new Promise(resolve => { release = resolve })
  const path = []
  const first = a.run(topic, async () => {
    path.push('read')
    started()
    await held
    path.push('received')
  })
  await entered
  const revoke = reopened.update({ action: 'revoke', chatId }).then(() => path.push('revoked'))
  const denied = assert.rejects(a.run(topic, () => path.push('unexpected read')), { code: 'admission-denied' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(path, ['read'])
  release()
  await Promise.all([first, revoke, denied])
  assert.deepEqual(path, ['read', 'received', 'revoked'])
  assert.deepEqual(await a.list(), [])
})

test('malformed commands, failed saves and mutations of result objects cannot grant access', async () => {
  const db = memory()
  let fail = false
  const a = createAdmission({ ...db, scope, save(key, record) {
    if (fail) throw new Error('save failed')
    db.save(key, record)
  } })
  const returned = await a.update({ action: 'register', chatId })
  returned[0].mode = 'permanent'
  const snapshot = await a.list()
  snapshot[0].mode = 'permanent'
  for (const cmd of [{ action: 'once', chatId }, { action: 'once', chatId, threadId: '' },
    { action: 'permanent', ...topic,grantId:'injected' }, { action: 'UNKNOWN', chatId }]) {
    await assert.rejects(a.update(cmd), { code: 'invalid-input' })
  }
  fail = true
  await assert.rejects(a.update({ action: 'permanent', chatId }), { code: 'storage-unavailable' })
  await assert.rejects(a.run(topic, hit), { code: 'admission-denied' })
  fail = false
  await a.update({ action: 'register', ...topic })
  await a.update({ action: 'once', ...topic })
  await assert.rejects(a.run(topic, async () => { throw new Error('read failed') }), /read failed/)
  assert.equal(await a.run(topic, hit), 'read')
})

test('invalid identity, group or root-message IDs never create records or run a read', async () => {
  const db = memory()
  const invalid = { code: 'invalid-input' }
  for (const changed of [
    { recipientId: chatId }, { recipientId: 'ou_' }, { recipientId: 'ou_' + 'k'.repeat(129) },
    { tenantId: '../other' }, { profile: '-other' }, { profile: 'a'.repeat(129) },
  ]) {
    assert.throws(() => createAdmission({ ...db, scope: { ...scope, ...changed } }), invalid)
  }
  const a = createAdmission({ ...db, scope })
  for (const bad of ['oc_', 'not-a-chat', topic.threadId, 'oc_a\n', 'oc_../x', 'oc_' + 'a'.repeat(129)]) {
    await assert.rejects(a.update({ action: 'register', chatId: bad }), invalid)
    await assert.rejects(a.run({ chatId: bad }, hit), invalid)
  }
  for (const threadId of [null, 'om_', 'omt_topic', chatId, ' om_a', 'om_a/b', 'om_' + 'a'.repeat(129)]) {
    await assert.rejects(a.update({ action: 'register', chatId, threadId }), invalid)
    await assert.rejects(a.update({ action: 'once', chatId, threadId }), invalid)
    await assert.rejects(a.run({ chatId, threadId }, hit), invalid)
  }
  assert.equal(db.records.size, 0)
  const max = { chatId: 'oc_' + 'a'.repeat(128), threadId: 'om_' + 'b'.repeat(128) }
  await a.update({ action: 'register', ...max })
  await a.update({ action: 'once', ...max })
  assert.equal(await a.run(max, hit), 'read')
})

test('unreadable or corrupt grant storage fails closed with a storage error', async () => {
  for (const load of [
    () => { throw new Error('private storage error') },
    key => ({ key, groups: [{ chatId, mode: 'once', threadId: 'omt_bad' }] }),
    key => ({ key, groups: [{ chatId, mode: 'pending', threadId: 'omt_bad' }] }),
    key => ({ key, groups: [{ ...topic, mode: 'permanent' }] }),
    ...[{ approvedAt: 0 }, { grantId: '00000000-0000-4000-8000-000000000000' },
        { approvedAt: 0, grantId: 'bad' }, { approvedAt: -1, grantId: '00000000-0000-4000-8000-000000000000' }]
      .map(extra => key => ({ key, groups: [{ ...topic, mode:'once', ...extra }] })),
    key => ({ key, groups: [{ chatId, mode: 'pending' }, { chatId, mode: 'permanent' }] }),
    key => ({ key, groups: [{ ...topic,mode:'pending' }, { ...topic,mode:'once' }] }),
    ...[{threadId:'om_else',at:2},{threadId:topic.threadId,at:1},{threadId:topic.threadId,at:2,handled:true}]
      .map(t=>key=>({key,consentSince:1,groups:[{...topic,mode:'pending',triggers:[{messageId:'om_ref',...t}]}]})),
  ]) {
    const a = createAdmission({ scope, load, save: assert.fail })
    await assert.rejects(a.run(topic, hit), { message: 'storage-unavailable', code: 'storage-unavailable' })
  }
})

const consentSince = 1000
const ref = {...topic,messageId:'om_first',at:1100}
const evidence = ({threadId,messageId,at})=>({threadId,messageId,at})
const fixture = () => {
  const db=memory()
  let ms=2000
  const open=(since=consentSince)=>createAdmission({...db,scope,consentSince:since,now:()=>ms})
  return {open,tick:()=>++ms}
}

test('only the first mention per topic registers; approval retains exact receipt evidence',async()=>{
  const {open}=fixture(), a=open()
  const second={...ref,messageId:'om_second',at:1200}, other={...second,threadId:'om_other'}
  for (const extra of [{text:'private body'},{handled:true},{approvedAt:1},{name:'x'.repeat(257)}]) {
    await assert.rejects(a.observe({...ref,...extra},consentSince),{code:'invalid-input'})
  }
  await assert.rejects(a.observe(ref,consentSince+1),{code:'scope-changed'})
  for (const at of [0,consentSince]) assert.deepEqual(await a.observe({...ref,at},consentSince),{changed:false})
  assert.deepEqual(await a.list(),[])
  assert.deepEqual(await a.observe({...ref,name:'某群'},consentSince),{changed:true})
  assert.deepEqual(await a.observe(second,consentSince),{changed:false})
  assert.deepEqual(await a.observe(other,consentSince),{changed:true})
  assert.deepEqual(await open().list(),[
    {...topic,name:'某群',mode:'pending',triggers:[evidence(ref)]},
    {chatId,threadId:other.threadId,mode:'pending',triggers:[evidence(other)]},
  ])
  const [once,pending]=await a.update({action:'once',...topic})
  assert.equal(pending.mode,'pending')
  assert.deepEqual(await a.observe(ref,consentSince),{grant:once,changed:false})
  for (const invalid of [second,{...ref,at:ref.at+1},{...ref,messageId:'om_forged'},{...second,at:once.approvedAt}]) {
    assert.deepEqual(await a.observe(invalid,consentSince),{changed:false})
  }
  assert.deepEqual(await a.observe({...second,at:once.approvedAt+1},consentSince),{grant:once,changed:false})
  const ack={...topic,messageId:ref.messageId,grantId:once.grantId}
  once.triggers[0].at=0
  assert.deepEqual((await open().list())[0].triggers,[evidence(ref)])
  assert.equal(await open().ackTrigger(ack),true)
  assert.equal(await a.ackTrigger(ack),false)
  assert.deepEqual(await a.observe(ref,consentSince),{changed:false})
  assert.deepEqual(await a.run(topic,g=>g.triggers),[{...evidence(ref),handled:true}])
})

test('only an exact verified self-mention may approve once; cached text, discovery hints and earlier pending items cannot',async()=>{
  const {open,tick}=fixture(),a=open(),other={...ref,messageId:'om_peer'},self={...ref,messageId:'om_self',at:1200}
  const body={...self,text:'owner request'},exact=()=>({...body,ownerSelfMention:true})
  await a.recordMention({...other,text:'another person'},consentSince)
  await a.observe(other,consentSince)
  await a.recordMention(body,consentSince)
  await assert.rejects(a.observe({...self,ownerSelfMention:true},consentSince),{code:'invalid-input'})
  for (const verify of [undefined,()=>body,()=>({...exact(),messageId:'om_fake'}),()=>({...exact(),text:'edited'})]) {
    assert.equal((await a.observe(self,consentSince,verify)).grant,undefined)
    assert.equal((await a.list())[0].mode,'pending')
  }
  const [{grant},again]=await Promise.all([a.observe(self,consentSince,exact),a.observe(self,consentSince,assert.fail)])
  assert.equal(grant.mode,'once');assert.equal(grant.threadId,self.threadId)
  assert.deepEqual(grant.triggers,[{...evidence(self),ownerSelfMention:true}]);assert.equal(again.grant.grantId,grant.grantId)
  await assert.rejects(a.run({chatId},hit),{code:'admission-denied'})
  assert.equal((await a.observe(other,consentSince)).grant,undefined)
  // Two self-mentions can be discovered in one page. Only these exact originals get exceptions.
  const next={...self,messageId:'om_self_2',at:self.at+1},b={...next,text:'second request'}
  await a.recordMention(b,consentSince)
  const second=await a.observe(next,consentSince,()=>({...b,ownerSelfMention:true}))
  assert.equal(second.grant.grantId,grant.grantId)
  assert.equal(second.grant.triggers.length,2)
  const reopened=open()
  for(const {messageId} of [self,next]){
    assert.equal(await reopened.ackTrigger({...topic,messageId,grantId:grant.grantId}),true)
  }
  assert.deepEqual(await reopened.observe(self,consentSince,assert.fail),{changed:false})
  const after={...other,messageId:'om_future',at:tick()}
  assert.equal((await reopened.observe(after,consentSince)).grant.grantId,grant.grantId)
  await reopened.update({action:'revoke',...topic})
  assert.deepEqual(await a.observe(self,consentSince,assert.fail),{changed:false},'revocation wins over a stale search page')
  await assert.rejects(a.run(topic,hit),{code:'admission-denied'})
})

test('an explicit self-mention never downgrades permanent access or changes its generation',async()=>{
  const a=fixture().open()
  await a.update({action:'register',...topic})
  const [grant]=await a.update({action:'permanent',...topic})
  const body={...ref,text:'self originally sent this'}
  await a.recordMention(body,consentSince)
  const checked=await a.observe(ref,consentSince,()=>({...body,ownerSelfMention:true}))
  assert.equal(checked.grant.mode,'permanent');assert.equal(checked.grant.grantId,grant.grantId)
  assert.equal(checked.grant.triggers.length,1)
})

test('revoke rejects rescans through its inclusive persistent cutoff; delayed acknowledgements cannot affect a replacement',async()=>{
  const {open,tick}=fixture(), a=open()
  await a.observe(ref,consentSince)
  const [once]=await a.update({action:'once',...topic})
  const cutoff=tick()
  assert.deepEqual(await a.update({action:'revoke',...topic}),[])
  for (const m of [ref,{...ref,messageId:'om_not_seen_yet',at:cutoff}]) {
    assert.deepEqual(await open().observe(m,consentSince),{changed:false})
  }
  await assert.rejects(a.update({action:'once',...topic}),{code:'admission-denied'})
  const other={...ref,threadId:'om_other',messageId:'om_other_mention'}
  assert.deepEqual(await a.observe(other,consentSince),{changed:true},'topic-specific revoke leaves other topics alone')
  await a.update({action:'register',...topic})
  await a.observe(ref,consentSince)
  assert.equal((await a.list()).find(g=>g.threadId===ref.threadId).triggers,undefined)
  const fresh={...ref,at:tick(),messageId:'om_new'}
  assert.deepEqual(await a.observe(fresh,consentSince),{changed:true})
  const approved=await open().update({action:'once',...topic})
  assert.equal(await a.ackTrigger({...topic,messageId:fresh.messageId,grantId:once.grantId}),false)
  assert.deepEqual(approved.find(g=>g.threadId===topic.threadId).triggers,[evidence(fresh)])
  assert.deepEqual(await a.observe(ref,consentSince),{changed:false})
})

test('permanent approval carries current trusted proposals only, never once grants or legacy metadata',async()=>{
  const {open,tick}=fixture(), a=open()
  const next={...ref,threadId:'om_t2',messageId:'om_t2_a'}, third={...ref,threadId:'om_t3',messageId:'om_t3_a'}
  const elsewhere={...ref,chatId:'oc_else'}
  for (const m of [ref,next,third,elsewhere]) await a.observe(m,consentSince)
  await a.update({action:'register',chatId,threadId:'om_metadata_only'})
  await a.update({action:'once',...topic})
  await assert.rejects(a.update({action:'permanent',...topic}),{code:'admission-denied'})
  await assert.rejects(a.update({action:'permanent',chatId}),{code:'admission-denied'})
  await a.update({action:'permanent',chatId,threadId:next.threadId})
  const [permanent,pending]=await open().list()
  assert.equal(pending.chatId,elsewhere.chatId)
  assert.deepEqual(permanent.triggers,[evidence(next),evidence(third)])
  assert.deepEqual(await a.observe(ref,consentSince),{changed:false})
  assert.equal(await a.run(topic,g=>g.grantId),permanent.grantId)
  const cutoff=tick()
  await a.update({action:'revoke',chatId})
  for(const m of [ref,next,third,{...ref,at:cutoff,threadId:'om_different'}]) {
    assert.deepEqual(await open().observe(m,consentSince),{changed:false})
  }
  assert.deepEqual(await open().list(),[pending])
})

test('new consent does not import the scan, discovered proposals or trigger exceptions; stale writers cannot roll it back',async()=>{
  const {open}=fixture(), old=open(), nextSince=consentSince+50, active=open(nextSince)
  const scan={since:consentSince+10,until:consentSince+20,pageToken:'p2'}
  assert.equal(await old.getScan(consentSince),undefined)
  await old.setScan(consentSince,scan)
  assert.deepEqual(await open().getScan(consentSince),scan)
  for(const s of [{since:1},{since:1015,until:1014},{since:1015,pageToken:'unbound'},{...scan,text:'x'}]) {
    await assert.rejects(old.setScan(consentSince,s),{code:'invalid-input'})
  }
  await old.observe(ref,consentSince)
  await old.observe({...ref,threadId:'om_other'},consentSince)
  await old.update({action:'once',...topic})
  assert.equal(await active.getScan(nextSince),undefined)
  const grants=await active.list()
  assert.equal(grants.length,1); assert.equal(grants[0].mode,'once'); assert.equal(grants[0].triggers,undefined)
  assert.equal(await active.run(topic,g=>g.triggers),undefined)
  assert.deepEqual(await active.observe(ref,nextSince),{changed:false})
  await active.setScan(nextSince,{since:nextSince})
  await assert.rejects(old.setScan(consentSince,scan),{code:'scope-changed'})
  assert.deepEqual(await open(nextSince).getScan(nextSince),{since:nextSince})
})

test('recording each verified body is scoped, durable, idempotent and grants no access',async()=>{
  const db=memory(), a=createAdmission({...db,scope,consentSince})
  const m={...ref,name:'设计',text:'核对排期'}, second={...m,messageId:'om_second',at:ref.at+1,text:'改为周五'}
  assert.equal(await a.getMention(ref,consentSince),null)
  assert.deepEqual(await Promise.all([a.recordMention(m,consentSince),a.recordMention(m,consentSince)]),[{changed:true},{changed:false}])
  assert.deepEqual(await a.recordMention({...m,text:'编辑后的覆盖'},consentSince),{changed:false})
  await assert.rejects(a.recordMention({...m,chatId:'oc_wrong'},consentSince),{code:'invalid-input'})
  for(const bad of [{text:''},{text:' '.repeat(12)},{text:'a'.repeat(65537)},{handled:true},{extra:'anything'}]) {
    await assert.rejects(a.recordMention({...m,...bad},consentSince),{code:'invalid-input'})
  }
  await a.recordMention(second,consentSince)
  assert.deepEqual(await a.list(),[])
  await assert.rejects(a.run(topic,hit),{code:'admission-denied'})
  await assert.rejects(a.update({action:'once',...topic,messageId:m.messageId}),{code:'admission-denied'})
  const reopened=createAdmission({...db,scope,consentSince})
  assert.deepEqual(await reopened.getMention(ref,consentSince),m)
  assert.equal(await reopened.getMention({...ref,at:ref.at+3},consentSince),null)
  assert.deepEqual(await reopened.listMentions(consentSince),[{...second,canApprove:false},{...m,canApprove:false}])
  await reopened.observe(ref,consentSince)
  assert.deepEqual(await reopened.listMentions(consentSince),[{...second,canApprove:true},{...m,canApprove:true}])
  assert.ok(!JSON.stringify(await reopened.list()).includes(m.text))
  assert.ok(!JSON.stringify([...db.records.values()]).includes(m.text))
  for (const prop of ['tenantId','recipientId','profile','managed']) {
    const other=createAdmission({...db,scope:{...scope,[prop]:prop==='managed'?true:scope[prop]+'_other'},consentSince})
    assert.deepEqual(await other.listMentions(consentSince),[])
    assert.equal(await other.getMention(ref,consentSince),null)
  }
  const next=createAdmission({...db,scope,consentSince:consentSince+1})
  assert.deepEqual(await next.listMentions(consentSince+1),[])
  assert.equal(await next.getMention(ref,consentSince+1),null)
  await next.setScan(consentSince+1,{since:consentSince+1})
  await assert.rejects(a.listMentions(consentSince),{code:'scope-changed'})
})

test('name repair can change only the readable spelling of a still-pending, unchanged archive',async()=>{
  const db=memory(), a=createAdmission({...db,scope,consentSince})
  const old='@_user_1 ping', fresh='@测试用户 ping'
  const body={...ref,name:'与自己的聊天',text:old}
  await a.recordMention(body,consentSince);await a.observe(ref,consentSince)
  const groups=await a.list(), exact={...ref,text:fresh,legacyText:old,ownerSelfMention:true}
  for(const r of [null,{...exact,legacyText:'different'},{...exact,text:''},{...exact,threadId:'om_wrong'}]) {
    assert.equal(await a.repairMentionNames(ref,consentSince,()=>r),false)
  }
  assert.deepEqual(await a.getMention(ref,consentSince),body)
  assert.equal(await a.repairMentionNames(ref,consentSince,()=>exact),true)
  assert.deepEqual(await a.getMention(ref,consentSince),{...body,text:fresh})
  assert.equal(await a.repairMentionNames(ref,consentSince,assert.fail),false)
  assert.deepEqual(await a.list(),groups);await assert.rejects(a.run(topic,hit),{code:'admission-denied'})
  const other={...ref,messageId:'om_second'}
  await a.recordMention({...other,text:old},consentSince)
  const started=Promise.withResolvers(),reply=Promise.withResolvers()
  const repair=a.repairMentionNames(other,consentSince,()=>{started.resolve();return reply.promise})
  await started.promise
  await a.update({action:'revoke',...topic})
  reply.resolve({...exact,...other})
  assert.equal(await repair,false);assert.equal((await a.getMention(other,consentSince)).text,old)
  assert.equal(await a.repairMentionNames(other,consentSince,assert.fail),false)
})

for(const action of ['once','permanent']) test(action+' from an activity replays only the clicked pending message',async()=>{
  const {open,tick}=fixture(), a=open()
  const refs=[ref,{...ref,messageId:'om_click',at:ref.at+1},{...ref,messageId:'om_t3',threadId:'om_t3'}]
  for(const r of refs) {
    await a.recordMention({...r,text:r.messageId},consentSince)
    await a.observe(r,consentSince)
  }
  for(const messageId of ['om_nonexistent','om_t3']) {
    await assert.rejects(a.update({action,...topic,messageId}),{code:'admission-denied'})
  }
  for(const cmd of [{action:'revoke',...topic},{action:'register',...topic},{action:'permanent',chatId}]) {
    await assert.rejects(a.update({...cmd,messageId:'om_click'}),{code:'invalid-input'})
  }
  const [approved]=await a.update({action,...topic,messageId:'om_click'})
  assert.deepEqual(approved.triggers,[evidence(refs[1])])
  const view=await open().listMentions(consentSince)
  assert.deepEqual(view.filter(m=>m.canApprove).map(m=>m.messageId),action==='once'?['om_t3']:[])
  assert.deepEqual(await a.observe(ref,consentSince),{changed:false})
  assert.deepEqual(await a.observe(refs[1],consentSince),{changed:false,grant:approved})
  const post=await a.observe({...ref,messageId:'om_latest',at:tick(),name:'补齐群名'},consentSince)
  assert.deepEqual(post,{changed:true,grant:{...approved,name:'补齐群名'}})
  await a.update({action:'revoke',chatId,...(action==='once'?{threadId:topic.threadId}:{})})
  const fresh={...ref,at:tick(),messageId:'om_fresh'}
  await a.recordMention({...fresh,text:'fresh'},consentSince); await a.observe(fresh,consentSince)
  assert.equal((await a.listMentions(consentSince)).find(m=>m.messageId==='om_click').canApprove,false)
  await assert.rejects(a.update({action,...topic,messageId:'om_click'}),{code:'admission-denied'})
  const updated=await a.update({action,...topic,messageId:'om_fresh'})
  assert.deepEqual(updated.find(g=>g.mode===action).triggers,[evidence(fresh)])
})

test('ignoring a conversation covers it whole: earlier messages leave activity, nothing new is recorded or proposed, and it can be undone',async()=>{
  const {open,tick}=fixture(), a=open()
  await a.recordMention({...ref,text:'第一条'},consentSince)
  await a.observe(ref,consentSince)
  const other={...ref,messageId:'om_other_chat',threadId:'om_oc',chatId:'oc_other'}
  await a.recordMention({...other,text:'别的群'},consentSince)
  await a.observe(other,consentSince)
  // An always-allowed conversation is revoked before it can be ignored.
  await a.update({action:'permanent',...topic})
  await assert.rejects(a.update({action:'ignore',chatId}),{code:'admission-denied'})
  await a.update({action:'revoke',chatId})
  assert.deepEqual(await a.update({action:'ignore',chatId}),[{chatId:other.chatId,threadId:other.threadId,mode:'pending',triggers:[evidence(other)]},{chatId,mode:'ignored',ignoredAt:2000}])
  assert.equal(await a.ignored(chatId),true)
  assert.deepEqual(await a.update({action:'ignore',chatId}),await a.list(),'repeat ignore writes nothing')
  // Earlier messages of the ignored conversation leave Activity, others remain.
  assert.deepEqual((await a.listMentions(consentSince)).map(m=>[m.chatId,m.messageId]),[[other.chatId,other.messageId]])
  // Neither a new mention nor a proposal from it is recorded while ignored.
  const later={...ref,messageId:'om_later',at:2100}
  assert.deepEqual(await a.recordMention({...later,text:'再说一句'},consentSince),{changed:false})
  assert.deepEqual(await a.observe(later,consentSince),{changed:false})
  assert.deepEqual(await a.update({action:'register',chatId,threadId:later.threadId}),await a.list())
  await assert.rejects(a.run(topic,()=>1),{code:'admission-denied'})
  // Undoing it restores normal proposals from the current moment on.
  await a.update({action:'revoke',chatId})
  assert.equal(await a.ignored(chatId),false)
  tick()
  assert.deepEqual(await a.observe({...later,at:3000},consentSince),{changed:true})
})

const member='ou_member', colleague='ou_colleague'
async function seen(a,...messages) {
  for(const [m,text=m.messageId] of messages) {await a.recordMention({...m,text},consentSince);await a.observe(m,consentSince)}
}
test('allowing only this user admits that member’s messages across the conversation, never another member or a browser-named one',async()=>{
  const {open,tick}=fixture(), a=open()
  const first={...ref,senderId:colleague}                                   // the topic's proposal began with someone else
  const mine={...ref,messageId:'om_mine',at:ref.at+1,senderId:member}      // the member in the same topic
  const elsewhere={chatId,threadId:'om_t2',messageId:'om_t2',at:ref.at+2,senderId:member}
  const anonymous={chatId,threadId:'om_t3',messageId:'om_t3',at:ref.at+3} // recorded before senders were kept
  await seen(a,[first],[mine,'  请帮我\n\n看一下   这个报表  '],[elsewhere],[anonymous])
  // The member always comes from the Host's recorded message, never from the browser.
  for(const cmd of [{action:'sender',...topic,messageId:mine.messageId,senderId:member},{action:'sender',...topic},{action:'sender',chatId,messageId:mine.messageId},
    {action:'once',...topic,senderId:member},{action:'permanent',chatId,senderId:member},{action:'register',chatId,senderId:member}])
    await assert.rejects(a.update(cmd),{code:'invalid-input'})
  for(const messageId of [anonymous.messageId,'om_missing'])
    await assert.rejects(a.update({action:'sender',chatId,threadId:messageId===anonymous.messageId ? anonymous.threadId : topic.threadId,messageId}),{code:'admission-denied'})
  await assert.rejects(a.update({action:'sender',...topic,messageId:elsewhere.messageId}),{code:'admission-denied'},'the message must belong to the named topic')
  const rows=await a.update({action:'sender',...topic,messageId:mine.messageId}), grant=rows.find(g=>g.mode==='sender')
  assert.deepEqual(grant,{chatId,mode:'sender',approvedAt:2000,grantId:grant.grantId,senderId:member,note:'请帮我 看一下 这个报表',triggers:[evidence(mine)]})
  // The topic's proposal stays for the colleague who started it.
  assert.deepEqual(rows.find(g=>g.threadId===topic.threadId),{...topic,mode:'pending',triggers:[evidence(first)]})
  assert.equal((await a.listMentions(consentSince)).find(m=>m.messageId===first.messageId).canApprove,true)
  // Only the member's requests can be read, released or answered under this grant, in any topic of this conversation.
  assert.equal(await a.run({chatId,threadId:'om_any',senderId:member},g=>g.grantId),grant.grantId)
  for(const target of [topic,{chatId},{...topic,senderId:colleague},{chatId:'oc_elsewhere',threadId:topic.threadId,senderId:member}])
    await assert.rejects(a.run(target,hit),{code:'admission-denied'})
  assert.deepEqual(await a.observe(mine,consentSince),{changed:false,grant})
  const later={chatId,threadId:'om_t4',messageId:'om_later',at:tick(),senderId:member}
  assert.deepEqual(await a.observe(later,consentSince),{changed:false,grant})
  // Someone else's new topic, or a message without a known sender, is proposed as usual.
  const stranger={chatId,threadId:'om_t5',messageId:'om_stranger',at:tick(),senderId:colleague}
  const {senderId:_,...unsigned}={...later,threadId:'om_t6',messageId:'om_unsigned',at:tick()}
  for(const m of [stranger,unsigned]) assert.deepEqual(await a.observe(m,consentSince),{changed:true})
  // Registering a topic proposes it and leaves the member grant intact and readable.
  await a.update({action:'register',chatId,threadId:'om_t7'})
  const reopened=await open().list()
  assert.deepEqual(reopened.find(g=>g.mode==='sender'),grant)
  assert.deepEqual(['om_t5','om_t6','om_t7'].map(id=>reopened.find(g=>g.threadId===id)?.mode),['pending','pending','pending'])
  // Allowing the same member from another topic adds that message to the same grant and settles their own proposal.
  const again=await a.update({action:'sender',chatId,threadId:elsewhere.threadId,messageId:elsewhere.messageId})
  assert.deepEqual(again.filter(g=>g.mode==='sender'),[{...grant,triggers:[evidence(mine),evidence(elsewhere)]}])
  assert.equal(again.some(g=>g.threadId===elsewhere.threadId),false)
  // Another member gets a separate grant; the shared topic's proposal goes once the member who started it is allowed.
  const both=await a.update({action:'sender',...topic,messageId:first.messageId})
  assert.deepEqual(both.filter(g=>g.mode==='sender').map(g=>[g.senderId,g.triggers]),[[member,[evidence(mine),evidence(elsewhere)]],[colleague,[evidence(first)]]])
  assert.equal(both.some(g=>g.threadId===topic.threadId),false)
  // Acknowledgement finds the member grant by its id; a handled request is not offered again.
  assert.equal(await a.ackTrigger({...topic,messageId:mine.messageId,grantId:'00000000-0000-4000-8000-000000000000'}),false)
  assert.equal(await a.ackTrigger({...topic,messageId:mine.messageId,grantId:grant.grantId}),true)
  assert.deepEqual(await a.observe(mine,consentSince),{changed:false})
})

test('a member grant is revoked by member; that member’s earlier messages stay closed while other members are unaffected',async()=>{
  const {open,tick}=fixture(), a=open()
  const mine={...ref,senderId:member}, theirs={chatId,threadId:'om_t2',messageId:'om_t2',at:ref.at+1,senderId:colleague}
  const earlier={chatId,threadId:'om_t3',messageId:'om_t3',at:ref.at+2,senderId:member}
  await seen(a,[mine],[theirs],[earlier])
  const grant=(await a.update({action:'sender',...topic,messageId:mine.messageId})).find(g=>g.mode==='sender')
  // Ignoring the whole conversation waits until the member grant is revoked.
  await assert.rejects(a.update({action:'ignore',chatId}),{code:'admission-denied'})
  // Revoking names the member; neither the conversation nor another member removes it.
  for(const cmd of [{action:'revoke',chatId},{action:'revoke',chatId,senderId:colleague},{action:'revoke',...topic}])
    await assert.rejects(a.update(cmd),{code:'admission-denied'})
  assert.deepEqual((await a.list()).find(g=>g.mode==='sender'),grant)
  const at=tick()
  const rows=await a.update({action:'revoke',chatId,senderId:member})
  assert.equal(rows.some(g=>g.mode==='sender'),false)
  await assert.rejects(a.run({...topic,senderId:member},hit),{code:'admission-denied'})
  // Their messages up to the revocation are neither proposed again nor approvable; discovery skips them unread.
  assert.deepEqual(await a.observe(mine,consentSince),{changed:false})
  assert.equal(await a.skip(mine),true);assert.equal(await a.skip({...mine,at}),true)
  for(const action of ['sender','once'])
    await assert.rejects(a.update({action,chatId,threadId:earlier.threadId,messageId:earlier.messageId}),{code:'admission-denied'})
  // Another member's message in the same conversation is still read and approvable.
  assert.equal(await a.skip(theirs),false)
  const other=(await a.update({action:'sender',chatId,threadId:theirs.threadId,messageId:theirs.messageId})).find(g=>g.mode==='sender')
  assert.equal(other.senderId,colleague)
  await assert.rejects(a.update({action:'ignore',chatId}),{code:'admission-denied'})
  // A newer message from the revoked member is proposed again.
  const fresh={chatId,threadId:'om_t4',messageId:'om_fresh',at:tick(),senderId:member}
  assert.equal(await a.skip(fresh),false)
  await seen(a,[fresh])
  assert.deepEqual((await a.list()).find(g=>g.threadId===fresh.threadId),{chatId,threadId:fresh.threadId,mode:'pending',triggers:[evidence(fresh)]})
  // An always-allowed conversation supersedes member grants; they never coexist with it.
  const all=await a.update({action:'permanent',chatId,threadId:fresh.threadId,messageId:fresh.messageId})
  assert.deepEqual(all.filter(g=>g.chatId===chatId).map(g=>g.mode),['permanent'])
  assert.equal(await a.run({chatId,threadId:'om_any',senderId:colleague},g=>g.mode),'permanent')
  const late={chatId,threadId:'om_t5',messageId:'om_late',at:tick(),senderId:colleague}
  await a.recordMention({...late,text:'late'},consentSince)
  assert.equal((await a.observe(late,consentSince)).grant.mode,'permanent')
  await assert.rejects(a.update({action:'sender',chatId,threadId:late.threadId,messageId:late.messageId}),{code:'admission-denied'})
})

test('ignoring once drops this topic’s proposal: the same message is not proposed again, a newer one is',async()=>{
  const {open,tick}=fixture(), a=open()
  const first={...ref,senderId:colleague}, second={...ref,messageId:'om_second',at:ref.at+1,senderId:member}
  const elsewhere={chatId,threadId:'om_t2',messageId:'om_t2',at:ref.at+2,senderId:colleague}
  await seen(a,[first],[second],[elsewhere])
  // Ignoring once names the exact recorded message of a pending topic.
  for(const cmd of [{action:'dismiss',...topic},{action:'dismiss',chatId,messageId:first.messageId},
    {action:'dismiss',...topic,messageId:first.messageId,senderId:colleague}])
    await assert.rejects(a.update(cmd),{code:'invalid-input'})
  for(const messageId of ['om_missing',elsewhere.messageId])
    await assert.rejects(a.update({action:'dismiss',...topic,messageId}),{code:'admission-denied'})
  const rows=await a.update({action:'dismiss',...topic,messageId:second.messageId})
  assert.deepEqual(rows,[{chatId,threadId:elsewhere.threadId,mode:'pending',triggers:[evidence(elsewhere)]}])
  // The messages remain in Activity but cannot be approved; nothing else in the conversation changed.
  assert.deepEqual((await a.listMentions(consentSince)).map(m=>[m.messageId,m.canApprove]),[[elsewhere.messageId,true],[second.messageId,false],[first.messageId,false]])
  for(const m of [first,second]) {
    assert.deepEqual(await a.observe(m,consentSince),{changed:false});assert.equal(await a.skip(m),true)
  }
  for(const action of ['once','permanent','sender','dismiss'])
    await assert.rejects(a.update({action,...topic,messageId:second.messageId}),{code:'admission-denied'})
  await assert.rejects(a.run(topic,hit),{code:'admission-denied'})
  // A newer message in that topic is proposed again, and only it is approvable there.
  const newer={...ref,messageId:'om_newer',at:tick(),senderId:colleague}
  assert.equal(await a.skip(newer),false)
  await seen(a,[newer])
  assert.deepEqual((await a.listMentions(consentSince)).filter(m=>m.canApprove).map(m=>m.messageId),[newer.messageId,elsewhere.messageId])
  const approved=(await a.update({action:'once',...topic,messageId:newer.messageId})).find(g=>g.mode==='once')
  assert.deepEqual(approved.triggers,[evidence(newer)])
})

test('discovery skips a message only when it could never be proposed: an ignored conversation or one at or before a cutoff',async()=>{
  const {open,tick}=fixture(), a=open()
  const mine={...ref,senderId:member}, other={chatId:'oc_other',threadId:'om_o',messageId:'om_o',at:ref.at,senderId:member}
  assert.equal(await a.skip(mine),false)
  assert.equal(await a.skip({...mine,at:consentSince}),true,'nothing at or before consent')
  await seen(a,[mine])
  assert.equal(await a.skip(mine),false,'a pending message is still read')
  await a.update({action:'ignore',chatId})
  assert.equal(await a.skip({...mine,at:tick()}),true);assert.equal(await a.skip(other),false)
  // Undoing an ignore starts from that moment: earlier messages stay unread, later ones are read again.
  const undone=tick()
  await a.update({action:'revoke',chatId})
  for(const [at,skipped] of [[ref.at,true],[undone,true],[undone+1,false]])
    assert.equal(await a.skip({...mine,messageId:'om_'+at,at}),skipped,String(at))
  // A revoked topic grant closes only that topic up to its revocation.
  const t2={chatId,threadId:'om_t2',messageId:'om_t2',at:tick(),senderId:colleague}
  await seen(a,[t2]);await a.update({action:'once',chatId,threadId:t2.threadId,messageId:t2.messageId})
  const end=tick();await a.update({action:'revoke',chatId,threadId:t2.threadId})
  assert.equal(await a.skip({...t2,messageId:'om_t2b',at:end}),true)
  assert.equal(await a.skip({...t2,threadId:'om_t3',messageId:'om_t3',at:end}),false)
  assert.equal(await a.skip({...t2,messageId:'om_t2c',at:end+1}),false)
})

test('allowing the same member twice in one topic keeps both approved messages until handled',async()=>{
  const {open}=fixture(), a=open()
  const m1={...ref,messageId:'om_m1',senderId:'ou_member',at:1100}, m2={...m1,messageId:'om_m2',at:1200}
  const other={...ref,messageId:'om_peer',senderId:'ou_peer',at:1050}
  for(const m of [other,m1,m2]) {await a.recordMention({...m,text:'消息 '+m.messageId},consentSince);await a.observe(m,consentSince)}
  await a.update({action:'sender',...topic,messageId:m1.messageId})
  await a.update({action:'sender',...topic,messageId:m2.messageId})
  const row=(await open().list()).find(g=>g.mode==='sender')
  assert.deepEqual(row.triggers.map(t=>t.messageId),['om_m1','om_m2'])
})

test('ignoring an earlier message once keeps a newer one already received in that topic awaiting approval',async()=>{
  const {open}=fixture(), a=open()
  const first={...ref,messageId:'om_a',senderId:'ou_x',at:1100}, newer={...first,messageId:'om_b',at:1300}
  for(const m of [first,newer]) {await a.recordMention({...m,text:'消息 '+m.messageId},consentSince);await a.observe(m,consentSince)}
  await a.update({action:'dismiss',...topic,messageId:first.messageId})
  const approvable=async()=>(await a.listMentions(consentSince)).filter(m=>m.canApprove).map(m=>m.messageId)
  assert.deepEqual(await approvable(),['om_b'])
  assert.deepEqual(await a.observe(first,consentSince),{changed:false})
  await a.update({action:'dismiss',...topic,messageId:newer.messageId})
  assert.deepEqual(await approvable(),[])
})

test('retry references for the allowed member never authorize the pending colleague and disappear on revoke',async()=>{
  const {open,tick}=fixture(), a=open(), diagnostic={at:2400,stage:'history',reason:'invalid-response'}
  const theirs={...ref,senderId:colleague}, mine={...ref,messageId:'om_mine',at:ref.at+1,senderId:member}
  await seen(a,[theirs],[mine])
  const g=(await a.update({action:'sender',...topic,messageId:mine.messageId})).find(g=>g.mode==='sender')
  const later={...mine,messageId:'om_later',at:tick()}, newer={...later,messageId:'om_newer',at:tick()}
  for(const m of [mine,later,newer]){
    await a.recordMention({...m,text:m.messageId},consentSince)
    await a.settleIntake(g,m,diagnostic)
  }
  await assert.rejects(a.settleIntake(g,theirs,diagnostic),{code:'admission-denied'})
  const current=(await open().list()).find(x=>x.mode==='sender')
  assert.deepEqual(current.failures.map(t=>t.messageId),[mine,later,newer].map(m=>m.messageId))
  assert.deepEqual(current.triggers,[evidence(mine)],'ordinary post-grant failures are not approval triggers')
  const rows=await a.listMentions(consentSince)
  for(const m of [mine,later,newer]){
    const r=rows.find(r=>r.messageId===m.messageId)
    assert.equal(r.canApprove,false);assert.deepEqual(r.intakeFailure,diagnostic)
  }
  assert.equal(rows.find(r=>r.messageId===theirs.messageId).canApprove,true)
  await a.settleIntake(g,mine)
  assert.equal((await a.list()).find(x=>x.mode==='sender').triggers[0].handled,true)
  assert.equal((await a.listMentions(consentSince)).find(x=>x.messageId===mine.messageId).intakeFailure,undefined)
  await a.update({action:'revoke',chatId,senderId:member})
  assert.ok(!(await open().listMentions(consentSince)).some(x=>x.intakeFailure))
})

test('promoting another request to permanent cannot restart a failed owner self-mention from the discarded grant',async()=>{
  const a=fixture().open(), mine={...ref,senderId:scope.recipientId}, body={...mine,text:'old'}
  const other={...ref,threadId:'om_new_topic',messageId:'om_new',at:ref.at+1,senderId:colleague}
  await a.recordMention(body,consentSince)
  const {grant}=await a.observe(mine,consentSince,()=>({...body,ownerSelfMention:true}))
  await a.settleIntake(grant,mine,{at:3000,stage:'history',reason:'context-too-large'})
  await seen(a,[other])
  const [permanent]=await a.update({action:'permanent',chatId,threadId:other.threadId,messageId:other.messageId})
  assert.deepEqual(permanent.triggers,[evidence(other)]);assert.equal(permanent.failures,undefined)
  assert.ok(await a.skip(mine))
  assert.deepEqual(await a.observe(mine,consentSince,assert.fail),{changed:false})
  await assert.rejects(a.settleIntake(grant,mine),{code:'admission-denied'})
  assert.ok(!(await a.listMentions(consentSince)).some(m=>m.intakeFailure))
})

test('ignoring a message once does not reopen the topic for a newer message an allowed member already covers',async()=>{
  const {open}=fixture(), a=open()
  const b={...ref,messageId:'om_b1',senderId:'ou_b',at:1100}, member={...b,messageId:'om_a1',senderId:'ou_a',at:1200}
  for(const m of [b,member]) {await a.recordMention({...m,text:'消息 '+m.messageId},consentSince);await a.observe(m,consentSince)}
  await a.update({action:'sender',...topic,messageId:member.messageId})
  await a.update({action:'dismiss',...topic,messageId:b.messageId})
  assert.ok(!(await a.list()).some(g=>g.mode==='pending'))
})
