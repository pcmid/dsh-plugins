import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { otherGroup,quietGroup,quietRoot } from './feishu.mjs'
import { noteAnswer,quietRequest } from './provider.mjs'

// The owner ignores one whole conversation: its mentions are neither read, recorded, proposed nor run.
const quiet={first:'om_quiet_first',during:'om_quiet_during',cold:'om_quiet_cold',newer:'om_quiet_newer'}
const ignoredPeriod=[quiet.during,quiet.cold], otherTopic='om_other_pending', name='Fixture quiet group'
const job=(s,id)=>s.automation.find(j=>j.messageId===id)
const activity=(s,id)=>s.mentions.find(m=>m.messageId===id)
const quietRows=groups=>groups.filter(g=>g.chatId===quietGroup)
const act=(app,row,action)=>app.groupAccess({action,scopeId:row.scopeId,chatId:row.chatId,threadId:row.threadId,messageId:row.messageId})
async function poll(app) {await app.pollOnce();await app.drain();return app.snapshot()}
async function attention(app,needed) {assert.equal((await app.attention()).needed,needed)}
function untouched(state,ids) {
  for(const id of ids)assert.ok(!activity(state,id) && !job(state,id),'nothing of an ignored conversation reaches Activity or the queue: '+id)
  assert.ok(!state.cases.some(c=>c.source.chatId===quietGroup),'no case for an ignored conversation')
}
// Known only from discovery metadata: never read by ID or with its body, never recorded.
function neverRead(transport,state,ids) {
  for(const id of ids) {
    assert.ok(!transport.exactReads.includes(id) && !transport.mgetBodies.includes(id),'never read: '+id)
    assert.ok(!activity(state,id) && !job(state,id),'never recorded: '+id)
  }
}

export async function ignoreBeforeExit(app,provider,transport) {
  const calls=provider.calls.length,posts=transport.posts.length
  // a) A pending mention from a fixture group, then the owner ignores the whole group.
  transport.publishQuietRoot()
  await delay(5)
  transport.publishQuiet(quiet.first,'Fixture quiet group: a mention before the owner ignores it.',quietRoot)
  const proposed=await poll(app),first=activity(proposed,quiet.first)
  assert.ifError(transport.error)
  assert.ok(transport.exactReads.includes(quiet.first))
  assert.deepEqual([first?.canApprove,first?.chatId,first?.threadId,first?.name],[true,quietGroup,quietRoot,name])
  assert.deepEqual(quietRows(proposed.source.groups).map(g=>[g.mode,g.threadId]),[['pending',quietRoot]])
  assert.ok(!job(proposed,quiet.first))
  const before=Date.now()
  const row=quietRows(await app.groupAccess({scopeId:first.scopeId,chatId:quietGroup,action:'ignore'}))
  assert.deepEqual(row,[{chatId:quietGroup,mode:'ignored',name,ignoredAt:row[0]?.ignoredAt}],'one row replaces the proposal')
  assert.ok(row[0].ignoredAt>=before && row[0].ignoredAt<=Date.now())
  untouched(await app.snapshot(),[quiet.first])
  assert.deepEqual(quietRows((await app.settingsSnapshot()).source.groups),row)

  // b) + c) In one poll: a new @ in the ignored group, and a mention in another group.
  await delay(5)
  const reads=transport.exactReads.length,searched=transport.searches.length
  transport.publishQuiet(quiet.during,'Fixture quiet group: a new topic while ignored.')
  transport.publishOtherTopic(otherTopic,'Fixture other group: an unrelated mention in the same poll.')
  const blocked=await poll(app)
  assert.ifError(provider.error);assert.ifError(transport.error)
  assert.ok(transport.searches.slice(searched).some(h=>h.includes(quiet.during) && h.includes(otherTopic)),'both were discovered by the same poll')
  assert.ok(!transport.exactReads.slice(reads).includes(quiet.during),'an ignored mention is never read')
  untouched(blocked,[quiet.first,quiet.during])
  assert.deepEqual(quietRows(blocked.source.groups),row)
  assert.equal(provider.calls.length,calls);assert.equal(transport.posts.length,posts)
  const other=activity(blocked,otherTopic)
  assert.ok(transport.exactReads.slice(reads).includes(otherTopic))
  assert.deepEqual([other?.canApprove,other?.chatId,other?.name],[true,otherGroup,'Fixture other group'])
  assert.equal(blocked.source.groups.find(g=>g.chatId===otherGroup && g.threadId===otherTopic)?.mode,'pending')
  // Leave no pending admission behind: the release phase checks attention at quiet points.
  await app.groupAccess({scopeId:other.scopeId,chatId:otherGroup,threadId:otherTopic,action:'revoke'})
  assert.equal(activity(await app.snapshot(),otherTopic)?.canApprove,false)
  console.log('PASS ignore conversation: ignoring a group replaced its pending proposal with one ignored row; its mention left Activity. A later @ there was discovered but never read, recorded or queued, while another group’s mention in the same poll was read and proposed. Zero model calls or posts.')
  return {ignoredAt:row[0].ignoredAt}
}

export async function ignoreAfterRestart(app,provider,transport,saved) {
  await attention(app,false)
  const settings=await app.settingsSnapshot(),scopeId=settings.source.scopeId
  const row=[{chatId:quietGroup,mode:'ignored',name,ignoredAt:saved.ignoredAt}]
  assert.deepEqual(quietRows(settings.source.groups),row,'the ignored row survived the cold Desktop exit')
  // Every release poll so far rediscovered the earlier mentions and still skipped them unread.
  assert.ok(transport.searches.some(h=>h.includes(quiet.first) && h.includes(quiet.during)))
  assert.ok(!transport.exactReads.some(id=>Object.values(quiet).includes(id)))

  // d) A new @ after the restart is still blocked, and nothing of the ignored group raises attention.
  const calls=provider.calls.length,posts=transport.posts.length,searched=transport.searches.length
  transport.publishQuiet(quiet.cold,'Fixture quiet group: another topic after the restart.')
  const cold=await poll(app)
  assert.ifError(provider.error);assert.ifError(transport.error)
  assert.ok(transport.searches.slice(searched).some(h=>h.includes(quiet.cold)))
  assert.ok(!transport.exactReads.some(id=>Object.values(quiet).includes(id)))
  untouched(cold,[quiet.first,...ignoredPeriod])
  assert.deepEqual(quietRows(cold.source.groups),row)
  assert.equal(provider.calls.length,calls);assert.equal(transport.posts.length,posts)
  await attention(app,false)

  // e) Undo. The earlier proposal returns only as history; nothing from the ignore period was ever recorded.
  assert.deepEqual(quietRows(await app.groupAccess({scopeId,chatId:quietGroup,action:'revoke'})),[])
  const restored=await app.snapshot()
  assert.deepEqual([activity(restored,quiet.first)?.canApprove,activity(restored,quiet.first)?.caseId],[false,undefined])
  for(const id of ignoredPeriod)assert.ok(!activity(restored,id),'no recorded body from the ignore period: '+id)
  await attention(app,false)
  await delay(5)
  const reads=transport.exactReads.length,found=transport.searches.length,fetched=transport.mgets.length
  transport.publishQuiet(quiet.newer,quietRequest,quietRoot)
  const proposed=await poll(app),newer=activity(proposed,quiet.newer)
  assert.ifError(transport.error)
  // The same poll found the ignore-period mentions again, but they are at or before the undo cutoff.
  assert.ok(transport.searches.slice(found).some(h=>[quiet.newer,...ignoredPeriod].every(id=>h.includes(id))),'rediscovered with the newer @')
  assert.ok(ignoredPeriod.every(id=>transport.mgets.slice(fetched).includes(id)),'only their metadata was fetched')
  neverRead(transport,proposed,ignoredPeriod)
  assert.ok(!transport.exactReads.includes(quiet.first))
  assert.ok(transport.exactReads.slice(reads).includes(quiet.newer))
  assert.deepEqual([newer?.canApprove,newer?.threadId,newer?.name],[true,quietRoot,name])
  assert.deepEqual(quietRows(proposed.source.groups).map(g=>[g.mode,g.threadId]),[['pending',quietRoot]])
  for(const id of [quiet.first,...ignoredPeriod]) {
    const m=activity(proposed,id)
    assert.ok((!m || m.canApprove===false) && !job(proposed,id),'not proposed again: '+id)
  }
  assert.equal(provider.calls.length,calls)
  await attention(app,true) // The newer mention alone is actionable.

  // f) Once the group is always allowed, it cannot be ignored; the ignore-period mentions still never run.
  await act(app,newer,'permanent')
  const ran=await poll(app),answered=job(ran,quiet.newer)
  assert.ifError(provider.error);assert.ifError(transport.error)
  assert.deepEqual(provider.calls.slice(calls),['DECIDE','WORK'])
  assert.deepEqual([answered?.status,answered?.answer],['awaiting-release',noteAnswer])
  for(const id of [quiet.first,...ignoredPeriod])assert.ok(!job(ran,id),'below the undo cutoff: '+id)
  neverRead(transport,ran,ignoredPeriod)
  const always=quietRows(ran.source.groups)
  assert.deepEqual(always.map(g=>g.mode),['permanent'])
  await assert.rejects(app.groupAccess({scopeId,chatId:quietGroup,action:'ignore'}),{code:'admission-denied'})
  assert.deepEqual(quietRows((await app.settingsSnapshot()).source.groups),always)
  await app.releaseOutput({caseId:answered.caseId,messageId:answered.messageId,token:answered.releaseToken,action:'decline'})
  await attention(app,false)
  assert.equal(transport.posts.length,posts)
  console.log('PASS ignore restart: the ignored row and its time survived the cold Desktop exit and still blocked a new @ unread; it never raised attention. After undo, polls rediscovered the ignore-period @s by metadata but never read them by ID or recorded them; a newer @ was read, proposed and ran once approved. Ignoring an always-allowed group was refused.')
}
