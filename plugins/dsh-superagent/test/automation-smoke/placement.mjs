import assert from 'node:assert/strict'
import {mkdir} from 'node:fs/promises'
import {join} from 'node:path'

export async function fixtureProject(ctx) {
  const path=join(process.cwd(),'fixture-project'),title='Fixture project'
  if(process.env.SMOKE_PHASE==='prepare') {
    await mkdir(path)
    await ctx.workspaceRegistry.create(path,title)
  }
  const ws=ctx.workspaceRegistry.list().find(w=>w.path===path)
  assert.equal(ws?.title,title,'the selected native workspace survives a cold restart')
  return {id:ws.id,title,path}
}

export async function checkPlacement(ctx,row,project) {
  const own=ctx.workspaceRegistry.list().find(w=>w.path===join(process.cwd(),'Superagent'))
  assert.ok(own)
  assert.ok(ctx.workspaceRegistry.archivedSessionIds.includes(row.routerSessionId),'a decided Router is already archived')
  assert.ok(!ctx.workspaceRegistry.archivedSessionIds.includes(row.workerSessionId),'routing did not archive this worker')
  assert.deepEqual([row.targetWorkspaceId,row.targetWorkspaceTitle],[project?.id,project?.title])
  await ctx.sessionPersistence.flush()
  for(const [id,ws] of [[row.routerSessionId,own],[row.workerSessionId,project ?? own]]) {
    const seat=await ctx.sessionPersistence.stat(id)
    assert.equal(seat?.header.cwd,ws.path)
    assert.deepEqual(ctx.workspaceRegistry.list().filter(w=>w.sessionIds.includes(id)).map(w=>w.id),[ws.id])
  }
}
