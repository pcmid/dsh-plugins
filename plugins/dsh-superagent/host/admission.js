import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'

const problem = code => Object.assign(new Error(code), { code })

const chat = z.string().regex(/^oc_[\w-]{1,128}$/)
// A thread is identified by a verified root message, never by a bare omt_ container.
const root = z.string().regex(/^om_[\w-]{1,128}$/)
const time = z.int().nonnegative(), generation = z.int().positive()
const name = z.string().max(256).optional()
const privateFields = {privatePeerId:z.string().regex(/^ou_[\w-]{1,128}$/).optional(),privateChatsSince:generation.optional()}
const samePeer = (a,b) => a.privatePeerId===b.privatePeerId && a.privateChatsSince===b.privateChatsSince
const withPeer = r => r.privatePeerId ? {privatePeerId:r.privatePeerId,privateChatsSince:r.privateChatsSince} : {}
const trigger = z.strictObject({threadId:root,messageId:root,at:time,handled:z.literal(true).optional(),ownerSelfMention:z.literal(true).optional()})
const mention = trigger.omit({handled:true,ownerSelfMention:true}).extend({chatId:chat,name,...privateFields})
const activity = mention.extend({text:z.string().max(65536).refine(text=>!!text.trim())})
export const mentionRecord = activity.extend({feed:z.string().regex(/^[a-f0-9]{64}$/)})
const target = z.strictObject({chatId:chat,threadId:root.optional()})
const updateCommand = target.extend({action:z.enum(['register','once','permanent','revoke']),messageId:root.optional()})
  .refine(c=>(c.action !== 'once' || !!c.threadId) &&
    (!c.messageId || c.threadId && ['once','permanent'].includes(c.action)))
const acknowledgement = z.strictObject({chatId:chat,threadId:root,messageId:root,grantId:z.uuidv4()})
const cursor = z.strictObject({since:time,until:time.optional(),pageToken:z.string().min(1).max(4096).optional()})
  .refine(c=>(c.until === undefined || c.until >= c.since) && (!c.pageToken || c.until !== undefined))
const common = {chatId:chat,name,...privateFields,triggers:z.array(trigger).min(1).optional()}
const epoch = {approvedAt:time.optional(),grantId:z.uuidv4().optional()}
const row = z.discriminatedUnion('mode', [
  z.strictObject({...common,mode:z.literal('pending'),threadId:root.optional()}),
  z.strictObject({...common,mode:z.literal('once'),threadId:root,...epoch}),
  z.strictObject({...common,mode:z.literal('permanent'),...epoch}),
]).refine(g=>{
  if ((g.privatePeerId===undefined)!==(g.privateChatsSince===undefined) || (g.approvedAt===undefined)!==(g.grantId===undefined)) return false
  if (!g.triggers) return true
  if (g.mode==='pending') return g.triggers.length===1 && g.triggers.every(t=>!t.handled && !t.ownerSelfMention && t.threadId===g.threadId)
  const manual=g.triggers.filter(t=>!t.ownerSelfMention)
  return !!g.grantId && new Set(g.triggers.map(t=>t.messageId)).size===g.triggers.length &&
    new Set(manual.map(t=>t.threadId)).size===manual.length && (g.mode==='permanent' || g.triggers.every(t=>t.threadId===g.threadId))
})

const targetKey = (chatId,threadId) => threadId ? chatId+'/'+threadId : chatId
export const admissionRecord = z.strictObject({
  key:z.string().regex(/^admission-[a-f0-9]{64}$/),groups:z.array(row),
  consentSince:generation.optional(),scan:cursor.optional(),
  privateScan:z.strictObject({epoch:generation,cursor}).optional(),
  revoked:z.record(z.string().regex(/^oc_[\w-]{1,128}(?:\/om_[\w-]{1,128})?$/),time).optional(),
}).refine(r=>{
  if (r.scan && (!r.consentSince || r.scan.since < r.consentSince)) return false
  const seen = new Set(), permanent = new Set()
  for (const g of r.groups) {
    const key = targetKey(g.chatId,g.threadId)
    if (seen.has(key) || g.triggers?.some(t=>!r.consentSince || t.at <= r.consentSince)) return false
    seen.add(key)
    if (g.mode === 'permanent') permanent.add(g.chatId)
  }
  return !r.groups.some(g=>g.mode !== 'permanent' && permanent.has(g.chatId))
})

const isId = (id,pattern) => typeof id === 'string' && id === id.trim() && pattern.test(id)
export function validAdmissionScope(scope) {
  return isId(scope?.tenantId, /^[\w-]{1,128}$/)
    && isId(scope?.recipientId, /^ou_[\w-]{1,128}$/)
    && isId(scope?.profile, /^\w[\w.-]{0,127}$/)
}

const queues = new WeakMap()
export function createAdmission({ scope, load, save, mentions, now = Date.now, consentSince, privateEpoch=()=>undefined }) {
  if (!validAdmissionScope(scope) || typeof now !== 'function' || typeof load !== 'function' ||
      typeof save !== 'function' || (consentSince !== undefined && !generation.safeParse(consentSince).success)) {
    throw problem('invalid-input')
  }
  const identity = [scope.tenantId, scope.recipientId, scope.profile]
  if (scope.managed === true) identity.push('superagent-managed')
  const key = 'admission-' + createHash('sha256').update(JSON.stringify(identity)).digest('hex')
  const feed = createHash('sha256').update(JSON.stringify([key,consentSince])).digest('hex')
  const feedKey = id => feed+'-'+id
  const livePeer = r => r.privatePeerId===undefined ? r.privateChatsSince===undefined :
    r.privatePeerId!==scope.recipientId && !!r.privateChatsSince && r.privateChatsSince===privateEpoch() && (r.at===undefined || r.at>r.privateChatsSince)

  // Recreating the connector for a settings change must not bypass an in-flight read or revoke.
  if (!queues.has(load)) queues.set(load,new Map())
  const queue = queues.get(load)
  function serial(fn) {
    const result = (queue.get(key) ?? Promise.resolve()).then(fn)
    const clear = () => { if (queue.get(key) === tail) queue.delete(key) }
    const tail = result.then(clear,clear)
    queue.set(key,tail)
    return result
  }
  async function read() {
    let record
    try {
      const stored = await load(key)
      record = stored == null ? {key,groups:[]} : admissionRecord.parse(stored)
      if (record.key !== key) throw new Error()
    } catch { throw problem('storage-unavailable') }
    if (record.consentSince !== consentSince) {
      if (consentSince && record.consentSince > consentSince) throw problem('scope-changed')
      // Preserve grants, not discovery cursors, proposals or historical exceptions from another consent.
      record.groups = record.groups.filter(g=>g.mode !== 'pending' || !g.triggers)
      for (const g of record.groups) delete g.triggers
      delete record.scan
      delete record.privateScan
      if (consentSince) record.consentSince = consentSince
      else delete record.consentSince
    }
    record.groups=record.groups.filter(livePeer)
    return record
  }
  async function write(record) {
    try { await save(key,structuredClone(record)) } catch { throw problem('storage-unavailable') }
  }
  function clock() {
    const ms = now()
    if (!time.safeParse(ms).success) throw problem('storage-unavailable')
    return ms
  }
  function checkConsent(value) {
    if (!consentSince || value !== consentSince) throw problem('scope-changed')
  }
  const cutoff = (record,chatId,threadId) => Math.max(consentSince ?? 0,
    record.revoked?.[chatId] ?? 0,record.revoked?.[targetKey(chatId,threadId)] ?? 0)
  function unpack(id,stored) {
    const m = mentionRecord.parse(stored)
    if (m.feed !== feed || id !== feedKey(m.messageId) || m.at <= consentSince) throw problem('storage-unavailable')
    return m
  }
  async function messageById(messageId) {
    try {
      const id = feedKey(messageId), stored = (await mentions(feed)).get(id)
      return stored === undefined ? undefined : unpack(id,stored)
    } catch { throw problem('storage-unavailable') }
  }
  const sameMention = (m,r) => !!m && m.chatId === r.chatId && m.threadId === r.threadId && m.at === r.at && m.messageId === r.messageId && samePeer(m,r)
  const authorized = (groups,chatId,threadId) => groups.find(g=>g.chatId === chatId &&
    (g.mode === 'permanent' || (g.mode === 'once' && g.threadId === threadId)))
  function approvedRow(group,mode) {
    return {chatId:group.chatId,mode,...withPeer(group),...(group.name ? {name:group.name} : {}),approvedAt:clock(),grantId:randomUUID()}
  }
  function proposal(groups,chatId,threadId) {
    let g = groups.find(g=>g.chatId === chatId && g.threadId === threadId)
    if (!g) {
      g = groups.find(g=>g.chatId === chatId && !g.threadId)
      if (!g) groups.push(g = {chatId,mode:'pending'})
      if (threadId) g.threadId = threadId
    }
    return g
  }
  return {
    list: () => serial(async()=>(await read()).groups),

    // Recording a verified body is not a grant. Keep it outside the routinely-read admission record.
    async recordMention(input,since) {
      checkConsent(since)
      const parsed = activity.safeParse(input)
      if (!parsed.success) throw problem('invalid-input')
      const m = parsed.data
      return serial(async()=>{
        await read()
        if (m.at <= since || !livePeer(m)) return {changed:false}
        const stored = await messageById(m.messageId)
        if (stored) {
          if (!sameMention(stored,m)) throw problem('invalid-input')
          return {changed:false}
        }
        try {
          const table=await mentions(feed)
          if (!livePeer(m)) return {changed:false}
          await table.put(feedKey(m.messageId),{...m,feed})
        } catch { throw problem('storage-unavailable') }
        return {changed:true}
      })
    },
    // Old archives stored Feishu's @_user_N keys. Only normalize unchanged, still-pending messages.
    async repairMentionNames(ref,since,lookup) {
      checkConsent(since)
      const pending=async()=>{
        const record=await read()
        if (!livePeer(ref) || ref.at<=cutoff(record,ref.chatId,ref.threadId) ||
            !record.groups.some(g=>g.mode==='pending' && g.chatId===ref.chatId && g.threadId===ref.threadId && samePeer(g,ref))) return
        const m=await messageById(ref.messageId)
        if (sameMention(m,ref) && /@_user_\d+/.test(m.text)) return m
      }
      const before=await serial(pending)
      if (!before) return false
      // Do not hold the authorization queue during CLI I/O; the owner may approve or revoke meanwhile.
      const exact=await lookup(ref)
      if (!sameMention(exact,ref) || exact.legacyText!==before.text || exact.text===before.text ||
          !activity.shape.text.safeParse(exact.text).success) return false
      return serial(async()=>{
        const stored=await pending()
        if (!stored || stored.text!==before.text) return false
        try {
          const table=await mentions(feed)
          if (!livePeer(stored)) return false
          await table.put(feedKey(ref.messageId),{...stored,text:exact.text})
        } catch { throw problem('storage-unavailable') }
        return true
      })
    },
    async getMention(input,since) {
      checkConsent(since)
      const parsed = mention.safeParse(input)
      if (!parsed.success) throw problem('invalid-input')
      return serial(async()=>{
        await read()
        const stored = await messageById(parsed.data.messageId)
        if (!sameMention(stored,parsed.data) || !livePeer(stored)) return null
        const {feed:_,...m} = stored
        return m
      })
    },
    async listMentions(since) {
      checkConsent(since)
      return serial(async()=>{
        const record = await read()
        const pending = new Set(record.groups.filter(g=>g.mode === 'pending').map(g=>targetKey(g.chatId,g.threadId)))
        const items = []
        try {
          for (const [id,stored] of (await mentions(feed)).entries()) {
            if (!id.startsWith(feed+'-')) continue
            const {feed:_,...m} = unpack(id,stored)
            items.push({...m,canApprove:livePeer(m) && pending.has(targetKey(m.chatId,m.threadId)) && m.at > cutoff(record,m.chatId,m.threadId)})
          }
        } catch { throw problem('storage-unavailable') }
        return items.sort((a,b)=>b.at-a.at || a.messageId.localeCompare(b.messageId))
      })
    },

    // Only the Host's verified CLI metadata goes through observe. A legacy proposer cannot supply evidence.
    async observe(ref,since,verifyOwn) {
      checkConsent(since)
      const parsed = mention.safeParse(ref)
      if (!parsed.success) throw problem('invalid-input')
      const {chatId,threadId,messageId,at,name} = parsed.data
      return serial(async()=>{
        const record = await read()
        if (at <= cutoff(record,chatId,threadId) || !livePeer(parsed.data)) return {changed:false}
        const grant = authorized(record.groups,chatId,threadId)
        if (grant && !samePeer(grant,parsed.data)) return {changed:false}
        const trigger=grant?.triggers?.find(t=>t.messageId===messageId)
        const covered=grant && (trigger || at>(grant.approvedAt ?? 0))
        // Discovery metadata, cached text, and browser input are never self-authorization.
        if (!covered && typeof verifyOwn==='function') {
          const stored=await messageById(messageId), exact=stored && await verifyOwn()
          if (exact?.ownerSelfMention===true && sameMention(exact,ref) && sameMention(stored,ref) && exact.text===stored.text && livePeer(exact)) {
            const own={threadId,messageId,at,ownerSelfMention:true}
            if (grant) {
              // Another request may have been granted in the same poll. Admit this exact self-mention,
              // not every message before that grant's cutoff; keep the original grant generation.
              grant.triggers=[...(grant.triggers ?? []),own]
              await write(record)
              return {grant,changed:true}
            }
            const pending=proposal(record.groups,chatId,threadId)
            const once={...approvedRow({...pending,...withPeer(ref),...(name?{name}:{})},'once'),threadId,triggers:[own]}
            record.groups[record.groups.indexOf(pending)]=once
            await write(record)
            return {grant:once,changed:true}
          }
        }
        if (grant) {
          const changed = !grant.name && !!name
          if (changed) { grant.name = name; await write(record) }
          return (trigger ? trigger.threadId===threadId && trigger.at===at && !trigger.handled : covered) ? {grant,changed} : {changed}
        }
        const pending = proposal(record.groups,chatId,threadId)
        Object.assign(pending,withPeer(parsed.data))
        if (pending.triggers) return {changed:false}
        pending.triggers = [{threadId,messageId,at}]
        if (name) pending.name = name
        await write(record)
        return {changed:true}
      })
    },
    async getScan(since) {
      checkConsent(since)
      return serial(async()=>(await read()).scan)
    },
    async setScan(since,value) {
      checkConsent(since)
      const parsed = cursor.safeParse(value)
      if (!parsed.success || parsed.data.since < since) throw problem('invalid-input')
      return serial(async()=>{
        const record = await read()
        record.scan = parsed.data
        await write(record)
      })
    },
    async getPrivateScan(epoch) {
      return serial(async()=>{
        const scan=(await read()).privateScan
        if (!epoch || epoch!==privateEpoch()) throw problem('scope-changed')
        return scan?.epoch===epoch ? scan.cursor : undefined
      })
    },
    async setPrivateScan(epoch,value) {
      const parsed=cursor.safeParse(value)
      if (!parsed.success || parsed.data.since<Math.max(consentSince || 0,epoch)) throw problem('invalid-input')
      return serial(async()=>{
        const record=await read()
        if (!epoch || epoch!==privateEpoch()) throw problem('scope-changed')
        record.privateScan={epoch,cursor:parsed.data}
        await write(record)
      })
    },
    async ackTrigger(input) {
      const parsed = acknowledgement.safeParse(input)
      if (!parsed.success) throw problem('invalid-input')
      const {chatId,threadId,messageId,grantId} = parsed.data
      return serial(async()=>{
        const record = await read(), grant = authorized(record.groups,chatId,threadId)
        const t = grant?.grantId === grantId && grant.triggers?.find(t=>t.threadId === threadId && t.messageId === messageId)
        if (!t || t.handled) return false
        t.handled = true
        await write(record)
        return true
      })
    },

    async update(command) {
      const parsed = updateCommand.safeParse(command)
      if (!parsed.success) throw problem('invalid-input')
      const {action,chatId,threadId,messageId} = parsed.data
      return serial(async () => {
        const record = await read(), groups = record.groups
        const group = groups.find(g=>g.chatId === chatId && g.threadId === threadId)
        if (action === 'register') {
          if (group || authorized(groups,chatId,threadId) || (!threadId && groups.some(g=>g.chatId === chatId))) return groups
          proposal(groups,chatId,threadId)
        } else if (action === 'revoke') {
          if (!group) throw problem('admission-denied')
          groups.splice(groups.indexOf(group),1)
          const revoked = record.revoked ??= {}, k = targetKey(chatId,threadId)
          revoked[k] = Math.max(revoked[k] ?? 0,group.approvedAt ?? 0,clock())
          for (const t of group.triggers ?? []) revoked[k] = Math.max(revoked[k],t.at)
        } else {
          if (group?.mode !== 'pending') throw problem('admission-denied')
          const approved = approvedRow(group,action)
          if (messageId) {
            const m = consentSince && await messageById(messageId)
            if (!m || !livePeer(m) || !samePeer(m,group) || m.chatId !== chatId || m.threadId !== threadId || m.at <= cutoff(record,chatId,threadId)) throw problem('admission-denied')
            approved.triggers = [{threadId,messageId,at:m.at}]
            if (m.name && !approved.name) approved.name = m.name
          }
          if (action === 'once') {
            approved.threadId = threadId
            if (!messageId && group.triggers) approved.triggers = group.triggers
            groups[groups.indexOf(group)] = approved
          } else {
            // Approval from an activity replays only that message. Older group actions keep their original trigger semantics.
            if (!messageId) {
              const triggers = groups.filter(g=>g.chatId === chatId && g.mode === 'pending').flatMap(g=>g.triggers ?? [])
              if (triggers.length) approved.triggers = triggers
            }
            record.groups = groups.flatMap(g=>g === group ? [approved] : g.chatId === chatId ? [] : [g])
          }
        }
        await write(record)
        return record.groups
      })
    },

    // Omit threadId for any group-wide read. Await all protected work inside the callback.
    async run(input, callback) {
      const parsed = target.safeParse(input)
      if (!parsed.success || typeof callback !== 'function') throw problem('invalid-input')
      const {chatId,threadId} = parsed.data
      return serial(async () => {
        const grant = authorized((await read()).groups,chatId,threadId)
        if (!grant) throw problem('admission-denied')
        return callback(Object.freeze(grant))
      })
    },
  }
}
