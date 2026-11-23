import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFile,writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32,deflateSync } from 'node:zlib'
import { createLoop } from '../../host/loop.js'
import { fileMarker,imageMarker } from '../../host/mention-text.js'
import { openStore } from '../../host/store.js'

// A valid 1x1 RGB PNG, so DSH's real attachment store decodes and admits it.
const signature=Buffer.from('89504e470d0a1a0a','hex')
function chunk(type,data) {
  const body=Buffer.concat([Buffer.from(type,'latin1'),data]),out=Buffer.alloc(body.length+8)
  out.writeUInt32BE(data.length,0);body.copy(out,4);out.writeUInt32BE(crc32(body),body.length+4)
  return out
}
const png=rgb=>Buffer.concat([signature,chunk('IHDR',Buffer.from([0,0,0,1,0,0,0,1,8,2,0,0,0])),
  chunk('IDAT',deflateSync(Buffer.from([0,...rgb]))),chunk('IEND',Buffer.alloc(0))])
const since=Date.now()-60_000
const image=(name,bytes,offset,messageId='om_images_request')=>({ref:{messageId,key:'img_fixture_'+name,at:since+offset},bytes})
// Oldest first. Only red and blue are images; the others are unreadable, not images, or fail DSH's decoder.
const red=image('red',png([255,0,0]),0),text=image('text',Buffer.from('not an image'),1)
const broken=image('broken',Buffer.concat([signature,Buffer.from('truncated')]),2),gone=image('gone',null,3)
const blue=image('blue',png([0,0,255]),4,'om_images_reply')
const bytesOf=new Map([red,text,broken,gone,blue].map(i=>[i.ref.key,i.bytes])),keys=list=>list.map(i=>i.ref.key)

const source={kind:'feishu',tenantId:'demo',recipientId:'ou_fixture',scopeId:'c'.repeat(64),chatId:'oc_images',threadId:'om_images_root'}
const team={lead:'superagent-lead',develop:'',answer:'superagent-answer'}
const models=model=>({lead:{provider:'offline',model:model ?? 'director'},answer:{provider:'offline',model:model ?? 'worker'}})
const seeing={caseId:'images-case',messageId:'om_images_request',requesterId:'ou_images',source,team,roleModels:models(),
  text:'Fixture image: what does '+imageMarker(red.ref.key)+' show?',workerImages:[red,text,broken,gone].map(i=>i.ref)}
const file={key:'file_fixture_log',messageId:'om_evidence',name:'evidence.csv',at:since+3},fileText='error,count\ntimeout,17\n'
// A later @ in the same topic is a message of the same case.
const follow={...seeing,messageId:blue.ref.messageId,text:'@Owner',workerImages:[blue.ref],workerFiles:[file],
  workerContext:JSON.stringify([{speaker:'requester',at:file.at,text:fileMarker(file.key,file.name)},{speaker:'requester',at:blue.ref.at,text:'@Owner',request:true}])}
const blind={caseId:'images-blind',messageId:'om_images_blind',requesterId:'ou_images',source:{...source,threadId:'om_images_blind'},team,
  roleModels:models('text-only'),text:'Fixture image: answer from text about '+imageMarker(red.ref.key)+'.',workerImages:[red.ref]}
const question='Fixture image: which part do you mean?',answers={seeing:'Fixture image: red, then blue.',blind:'Fixture image: answered from text alone.'}

// One SuperAgent prompt: its text, then each new image's marker and its admitted attachment.
function promptWith(content,stage,shown) {
  assert.match(content[0]?.type==='text' && content[0].text,new RegExp('^SUPERAGENT_'+stage+'\n'))
  assert.equal(content.length,1+2*shown.length,JSON.stringify(content))
  return shown.map((img,i)=>{
    const [marker,block]=content.slice(1+2*i)
    assert.deepEqual(marker,{type:'text',text:imageMarker(img.ref.key)})
    assert.equal(block.type,'image',JSON.stringify(block))
    assert.match(block.attachment?.attachmentId ?? '',/^sha256:[0-9a-f]{64}$/,JSON.stringify(block))
    assert.equal(block.attachment.mediaType,'image/png')
    return block.attachment.attachmentId
  })
}
// The seat's SuperAgent prompts as DSH recorded them; every turn completed.
async function prompts(ctx,id) {
  await ctx.sessionPersistence.flush()
  const log=await ctx.sessionPersistence.open(id,'read')
  try {
    const {events}=await log.read()
    assert.ok(events.filter(e=>e.type==='turn/end').every(e=>e.data.reason.kind==='completed'))
    return events.filter(e=>e.type==='user/message' && e.data.source.kind==='user').map(e=>e.data.content)
  } finally {await log.close()}
}

export async function imagesRound(ctx,provider,actors) {
  const requests=[],loads=[],sent=[],calls=provider.calls.length
  // The offline model answers these requests and records what each native request carried.
  provider.imageTurn=({stage,options,input,canonical})=>{
    if(input.request!==follow.text && !input.request.startsWith('Fixture image:'))return
    requests.push({stage,sessionId:options.sessionId,model:options.model,content:canonical.content,
      images:options.messages.flatMap(m=>m.content.filter(b=>b.type==='image').map(b=>b.attachment?.attachmentId))})
    if(stage==='DECIDE' && input.request===follow.text){
      assert.equal(input.helpers,undefined,'the case already has its worker: no new work is routed')
      assert.deepEqual(input.openWork,[{ref:'w1',request:seeing.text,state:'waiting for the requester',output:question}])
      assert.equal(JSON.parse(input.topic)[0].text,fileMarker(file.key,file.name));assert.ok(!canonical.content.some(b=>b.type==='file'))
      return ['superagent_merge',{target:'w1'}]
    }
    if(stage==='DECIDE')return ['superagent_route',{role:'answer'}]
    if(input.request===blind.text)return ['superagent_answer',{answer:answers.blind}]
    if(!input.continue)return ['superagent_ask_requester',{question}]
    assert.deepEqual(input.supplements,[{text:follow.text,from:'requester'}])
    return ['superagent_answer',{answer:answers.seeing}]
  }
  const loader=stage=>refs=>{loads.push([stage,refs.map(r=>r.key)]);return Promise.resolve(refs.map(r=>bytesOf.get(r.key)))}
  const path=join(tmpdir(),file.name)
  await writeFile(path,fileText,{flag:'wx'})
  const loadFiles=async(refs,use)=>{assert.deepEqual(refs,[file]);return [await use(0,path)]}
  const store=await openStore({open:spec=>ctx.storageDomain.open({...spec,name:'images_fixture_'+spec.name})})
  const loop=createLoop({...store.automationStore,isReleaseRequired:()=>false,caseInfo:()=>seeing,
    decide:j=>actors.decide({...j,loadImages:loader('decide')}),work:j=>actors.work({...j,loadImages:loader('work'),loadFiles}),
    deliver:async d=>{sent.push(d.text);return {chatId:d.source.chatId,inReplyTo:d.messageId,messageId:'om_images_receipt_'+sent.length}}})
  try {
    await loop.enqueue(seeing);await loop.drain()
    const [waiting]=await loop.snapshot()
    assert.deepEqual([waiting.status,waiting.messageId],['waiting-requester',seeing.messageId])
    // Only the bare @ is enqueued. Its context brings the file and blue image to the original worker.
    await loop.enqueue(follow)
    await loop.drain()
    await loop.enqueue(blind);await loop.drain()
    assert.ifError(provider.error)
    const rows=await loop.snapshot(),row=id=>rows.find(r=>r.messageId===id)
    assert.deepEqual([seeing,blind].map(j=>[row(j.messageId)?.status,row(j.messageId)?.answer]),
      [['delivered',answers.seeing],['delivered',answers.blind]],JSON.stringify(rows))
    assert.deepEqual([row(follow.messageId).status,row(follow.messageId).mergedInto],['merged',{caseId:seeing.caseId,messageId:seeing.messageId}])
    assert.deepEqual(sent,[question,answers.seeing,answers.blind])
    assert.deepEqual(provider.calls.slice(calls),['DECIDE','WORK','DECIDE','WORK','DECIDE','WORK'])

    // Each seat loaded its images newest first, never one it had already received; the text-only model loaded none.
    const first=keys([gone,broken,text,red])
    assert.deepEqual(loads,[['decide',first],['work',first],['decide',keys([blue])],['work',keys([blue,gone,broken,text])]])
    const seats=await actors.seats(seeing),followSeats=await actors.seats(follow),blindSeats=await actors.seats(blind)
    const [routed]=await prompts(ctx,seats.routerSessionId),[asked,resumed]=await prompts(ctx,seats.workerSessionId)
    const [routedFollow]=await prompts(ctx,followSeats.routerSessionId)
    const [routerRed]=promptWith(routed,'DECIDE',[red]),[workerRed]=promptWith(asked,'WORK',[red]),[workerBlue]=promptWith(resumed.slice(0,-2),'WORK',[blue])
    assert.deepEqual(promptWith(routedFollow,'DECIDE',[blue]),[workerBlue])
    assert.deepEqual(resumed.at(-2),{type:'text',text:fileMarker(file.key,file.name)})
    assert.deepEqual(resumed.at(-1),{type:'file',attachment:{attachmentId:'sha256:'+createHash('sha256').update(fileText).digest('hex'),name:file.name,bytes:Buffer.byteLength(fileText)}})
    assert.equal(routerRed,workerRed,'the same image is the same content-addressed attachment')
    assert.notEqual(workerBlue,workerRed)
    for(const id of Object.values(blindSeats))(await prompts(ctx,id)).forEach(c=>promptWith(c,id===blindSeats.routerSessionId?'DECIDE':'WORK',[]))

    // The model requests carried exactly the recorded messages: the admitted images, or text only.
    assert.deepEqual(requests.map(r=>[r.stage,r.sessionId,r.model,r.images]),[
      ['DECIDE',seats.routerSessionId,'director',[routerRed]],['WORK',seats.workerSessionId,'worker',[workerRed]],
      ['DECIDE',followSeats.routerSessionId,'director',[workerBlue]],['WORK',seats.workerSessionId,'worker',[workerRed,workerBlue]],
      ['DECIDE',blindSeats.routerSessionId,'text-only',[]],['WORK',blindSeats.workerSessionId,'text-only',[]]])
    assert.deepEqual(requests.slice(0,3).map(r=>r.content),[routed,asked,routedFollow])
    const visible=requests[3].content,copy=ctx.get('attachments').fileHostPath(resumed.at(-1).attachment)
    assert.deepEqual(visible.slice(0,-1),resumed.slice(0,-1))
    assert.equal(visible.at(-1).type,'text')
    assert.ok(typeof copy==='string' && visible.at(-1).text.includes(copy),'DSH tells only the worker where its read-only copy lives')
    assert.equal(await readFile(copy,'utf8'),fileText)
    console.log('PASS images: Router and worker received each admitted image, the bare mention merged and gave the original worker the new image and exact file bytes, and both answers were delivered. Unreadable images and the text-only model still produced no attachment.')
  } finally {
    provider.imageTurn=undefined
    await loop.dispose();await store.close()
  }
}
