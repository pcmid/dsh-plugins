import { z } from 'zod'
import { admissionRecord,mentionRecord } from './admission.js'
import { pollLog } from './poll-diagnostics.js'

const entry = z.object({schema:z.literal(1),
  team:z.object({lead:z.string(),develop:z.string(),answer:z.string()}),
  roleModels:z.record(z.string(),z.json()),cases:z.array(z.record(z.string(),z.json())),
  roleDefaultsApplied:z.literal(true).optional(),releaseRequired:z.boolean().optional(),
})
// Keep authorization separate from case writes; neither can overwrite the other.
const loopState=z.strictObject({schema:z.literal(1),jobs:z.array(z.record(z.string(),z.json()))})
const spec = {name:'pcmid_superagent',version:8,compatibleVersions:[1,2,3,4,5,6,7],tables:{
  workspace:{valueSchema:entry},
  automation:{valueSchema:loopState},
  admission:{valueSchema:admissionRecord},
}}

export async function openStore(facility) {
  const domain = await facility.open(spec)
  const records = domain.table('workspace'), grants = domain.table('admission'), jobs = domain.table('automation')
  // The Domain facility loads every value on open. Isolate each consent so neither settings reads
  // nor opening another account's activity ever loads these bodies.
  const feeds = new Map()
  async function mentions(feed) {
    if (!/^[a-f0-9]{64}$/.test(feed)) throw new Error('invalid feed')
    if (!feeds.has(feed)) {
      const opening = facility.open({name:'pcmid_superagent_mentions_'+feed,version:1,layout:'per-record',
        tables:{mentions:{valueSchema:mentionRecord}}})
      feeds.set(feed,opening)
      opening.catch(()=>feeds.delete(feed))
    }
    return (await feeds.get(feed)).table('mentions')
  }
  // Open logs on demand: an absent or damaged diagnostic domain must not disable the workspace/ACL store.
  const logRows=z.array(pollLog).max(20)
  let logs,logTail=Promise.resolve()
  async function logTable(bindingId) {
    if (typeof bindingId!=='string' || !/^[a-f0-9]{64}$/.test(bindingId)) throw new Error('invalid binding')
    logs ??= facility.open({name:'pcmid_superagent_poll_logs',version:1,layout:'per-record',
      tables:{bindings:{valueSchema:logRows}}}).catch(e=>{logs=undefined;throw e})
    return (await logs).table('bindings')
  }
  const pollLogs={
    async list(bindingId) {
      await logTail
      const rows=(await logTable(bindingId)).get(bindingId)
      return logRows.parse(rows ?? [])
    },
    async append(bindingId,value) {
      const row=pollLog.parse(value)
      const op=logTail.then(async()=>{
        const table=await logTable(bindingId)
        const rows=logRows.parse(table.get(bindingId) ?? [])
        await table.put(bindingId,[row,...rows].sort((a,b)=>b.at-a.at).slice(0,20))
      })
      logTail=op.catch(()=>{})
      return op
    },
  }
  return {
    automationStore:{load:()=>jobs.get('loop'),save:record=>jobs.put('loop',loopState.parse(record))},
    state:{load:()=>records.get('cases'),save:record=>records.put('cases',entry.parse(record))},
    permissions:{mentions,pollLogs,load:key=>grants.get(key),save:(key,record)=>grants.put(key,spec.tables.admission.valueSchema.parse(record))},
    async close() {
      await logTail
      await Promise.all([domain.close(),logs?.then(d=>d.close()),...[...feeds.values()].map(opening=>opening.then(d=>d.close()))])
    },
  }
}
