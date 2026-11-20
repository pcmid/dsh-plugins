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
  epoch=undefined
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
