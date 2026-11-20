import s from '@deepseek-ai/schemastery'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { openStore } from './host/store.js'
import { createActors } from './host/actors.js'
import { makeApp } from './host/app.js'
import { ownerRoutes } from './host/routes.js'
import { starterTeam } from './host/role-defaults.js'

export const name = 'pcmid-superagent'
export const inject = ['connection','storageDomain','agentPresets']
export const Config = s.object({
  feishu:s.object({
    enabled:s.boolean().default(false).description('启用飞书来源。内部群与「与自己的聊天」仅接收直接 @本人的消息；可另外开启其他人的私聊。只有获准的会话或话题才交给助手办理。'),
    allowPrivateChats:s.boolean().default(false).description('接收新私聊，默认关闭。他人私聊无需 @，但和群提及一样需要办理授权；本人明确 @自己按「批准一次」处理。'),
    privateChatsSince:s.number().description('本绑定开启他人私聊的时间，仅处理在此之后收到的新私聊。'),
    cliPath:s.string().description('本机 lark-cli 可执行文件的绝对路径；留空使用系统 PATH。'),
    pollIntervalMinutes:s.number().step(1).min(1).max(1440).default(1).description('系统 lark-cli 的后台轮询间隔（分钟，1–1440）。'),
    historyCount:s.number().step(1).min(0).max(100).default(10).description('无原生话题时补读的前文条数上限。与时间上限同时生效，0 表示不补读。'),
    historyMinutes:s.number().step(1).min(0).max(1440).default(5).description('无原生话题时向前查找的分钟数。与条数上限同时生效，0 表示不补读。'),
    profile:s.string().description('已保存的飞书应用配置。'),
    automationSince:s.number().description('本人授权自动办理与回复的生效时间。未授权不启动。'),
    managed:s.boolean().description('使用 SuperAgent 专用的飞书应用配置目录。'),
    tenantId:s.string().description('绑定的飞书租户标识。'),
    recipientId:s.string().description('被 @ 的本人 open_id，不是机器人。'),
  }).default({}).volatile(),
})

// The session cwd contains work products, not this plugin’s durable records or profile settings.
export function caseWorkspace(env = process.env) {
  const home = resolve(env.DSH_HOME?.trim() || join(homedir(),'.dsh'))
  const profile = env.DSH_PROFILE_DIR || env.DSH_PROFILE || 'default'
  const id = createHash('sha256').update(profile).digest('hex').slice(0,16)
  return join(home,'superagent-workspaces',id)
}
// CLI credential directories are always Host-owned, independent of the executable setting.
export function feishuDirectory(profile, env = process.env) {
  const home = resolve(env.DSH_HOME?.trim() || join(homedir(),'.dsh'))
  const hash = createHash('sha256').update(JSON.stringify([env.DSH_PROFILE_DIR || env.DSH_PROFILE || 'default',profile])).digest('hex')
  return join(home,'superagent-feishu',hash)
}
export async function apply(ctx, config) {
  const store = await openStore(ctx.storageDomain)
  try {
    const api = makeApp({
      readConfig:()=>typeof config.feishu?.get === 'function' ? config.feishu.get() : config.feishu,
      saveConfig:async (next,check)=>{
        const editor=ctx.get('configEditor'), entry=ctx.fiber.entry
        if (!editor || !entry) throw new Error('settings-unavailable')
        await editor.edit(entry, current=>{
          check()
          return {...current,feishu:next}
        })
      },
      managedDir:feishuDirectory,state:store.state,permissions:store.permissions,automationStore:store.automationStore,
      actors:createActors(ctx,{workspacePath:caseWorkspace()}),
      listPresets:()=>ctx.agentPresets.list(),roleDefaults:()=>starterTeam(ctx),
    })
    ctx.effect(() => async () => {try {await api.dispose()} finally {await store.close()}}, 'superagent: release source and workspace')
    // Trusted source adapters can propose a topic, not submit work, grant access or deliver.
    ctx.provide('superagentRequests',Object.freeze({requestAccess:api.requestAccess}))
    ownerRoutes(ctx.connection,api)
    void Promise.resolve(api.start()).catch(()=>ctx.logger('superagent').warn('Automatic dispatch recovery did not complete.'))
  } catch (e) {
    await store.close()
    throw e
  }
}
