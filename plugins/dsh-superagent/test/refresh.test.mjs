import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source=await readFile(new URL('../src/runtime.js',import.meta.url),'utf8')
const refresh=new Function(source+';return spaceRefreshWorkspace')()

function feedback() {
  const states=[]
  return {active:{current:true},pending:{current:false},setRefreshing:value=>states.push(value),states}
}

test('a second click starts no reads; feedback lasts until both reads finish',async()=>{
  const manual=feedback(),snapshot=Promise.withResolvers(),roster=Promise.withResolvers(),calls=[]
  const click=()=>refresh(()=>{calls.push('snapshot');return snapshot.promise},()=>{calls.push('roster');return roster.promise},manual)
  const first=click()
  await click()
  assert.deepEqual(calls,['snapshot','roster'])
  snapshot.resolve()
  await new Promise(setImmediate)
  assert.deepEqual(manual.states,[true])
  await click()
  assert.deepEqual(calls,['snapshot','roster'])
  roster.resolve()
  await first
  assert.deepEqual(manual.states,[true,false])
  await click()
  assert.deepEqual(calls,['snapshot','roster','snapshot','roster'])
})

test('a background refresh can finish without clearing a manual refresh',async()=>{
  const manual=feedback(),wait=Promise.withResolvers(),calls=[]
  const first=refresh(()=>wait.promise,()=>{},manual)
  await refresh(()=>calls.push('snapshot'),()=>calls.push('roster'))
  assert.deepEqual(calls,['snapshot','roster'])
  assert.deepEqual(manual.states,[true])
  wait.resolve()
  await first
  assert.deepEqual(manual.states,[true,false])
})

test('failure releases the button; no feedback or new reads after unmount',async()=>{
  const manual=feedback()
  await assert.rejects(refresh(()=>Promise.reject(Error('offline')),()=>{},manual),/offline/)
  assert.deepEqual(manual.states,[true,false])
  const wait=Promise.withResolvers(),first=refresh(()=>wait.promise,()=>{},manual)
  manual.active.current=false
  wait.resolve()
  await first
  await refresh(assert.fail,assert.fail,manual)
  assert.deepEqual(manual.states,[true,false,true])
})
