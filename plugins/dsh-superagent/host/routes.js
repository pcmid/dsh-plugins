// DSH Connection authenticates exact fetch routes and rejects non-owner peers.
// No route accepts an inbound Feishu message, DSH session ID, cwd or reply target.
const fields = {
  snapshot: [],
  settingsSnapshot: [],
  viewRevision: [],
  attention: [],
  setPollInterval: ['version','pollIntervalMinutes'],
  setCliPath: ['version','cliPath'],
  setHistoryLimits: ['version','historyCount','historyMinutes'],
  setPrivateChats: ['version','allowPrivateChats'],
  configure: ['team','roleModels'],
  setReleasePolicy: ['required'],
  releaseOutput: ['caseId','messageId','token','action'],
  archiveCase: ['caseId'],
  retryWork: ['caseId','messageId'],
  takeOver: ['caseId','messageId'],
  groupAccess: ['scopeId','chatId','action','threadId','messageId'],
  syncFeishu: ['scopeId','chatId','threadId'],
  saveFeishu: ['version','enabled','profile','managed'],
  startFeishuAuth: ['version','kind','automation'],
  finishFeishuAuth: ['version','flowId'],
  cancelFeishuAuth: ['version','flowId'],
}
const failure = (code,message) => ({ok:false,error:{code,message,details:{}}})
const malformed = () => failure('invalid-input','请求格式不正确，请刷新后重试。')
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x)

export function ownerRoutes(connection, api) {
  for (const [endpoint, keys] of Object.entries(fields)) {
    connection.fetch.register({
      path: '/api/pcmid/superagent/' + endpoint, methods:['POST'], requestBody:'buffered',
      async fetch(req) {
        const bytes = await req.arrayBuffer()
        if (bytes.byteLength > 128 * 1024) return new Response('Request too large',{status:413})
        let envelope
        try { envelope = JSON.parse(new TextDecoder().decode(bytes)) }
        catch { return new Response('Invalid JSON',{status:400}) }
        if (typeof envelope?.rpcId !== 'string' || !envelope.rpcId || envelope.rpcId.length > 180)
          return new Response('Missing correlation ID',{status:400})
        const {rpcId,payload} = envelope
        let result
        try {
          if (envelope.type !== 'client-request' || !object(payload) ||
              Object.keys(payload).some(key => !keys.includes(key))) result = malformed()
          else result = {ok:true,value:await api[endpoint](payload)}
        } catch (e) {
          // Only reviewed domain messages are meant for the browser. Never relay CLI stderr,
          // provider exceptions, filesystem locations or request contents in an RPC failure.
          result = publicFailure(e)
        }
        return Response.json({type:'server-response',rpcId,result},{headers:{'Cache-Control':'no-store'}})
      }
    })
  }
}

const messages = Object.freeze({
  'invalid-input':'请求无效，请重新选择。',
  'invalid-cli-path':'请填写本机可执行的 lark-cli 文件绝对路径，或留空使用系统 PATH。',
  'release-stale':'这份答复已处理或已变更，请刷新后查看。',
  'retry-unavailable':'这条消息当前不能重试，请刷新后查看。',
  'takeover-unavailable':'这条消息当前不能接手，请刷新后查看。',
  'preset-unavailable':'角色预设已不可用，请重新选择。',
  'roster-unavailable':'暂时无法读取预设目录。',
  'case-not-found':'没有找到这个事项。',
  'request-conflict':'请求标识已被另一份委托使用，请刷新。',
  'case-busy':'事项正在提交，请稍后查看。',
  'dispatch-uncertain':'尚不能确认 DSH 是否接单，请先检查原会话。',
  'storage-unavailable':'无法读取或保存工作区，未确认更改。',
  'source-unconfigured':'请先在 SuperAgent 设置中连接飞书。',
  'settings-unavailable':'工作区设置未能保存，请刷新后检查。',
  'auth-unavailable':'无法完成飞书授权，请检查本机 CLI、应用权限及连接。',
  'auth-profile-exists':'专用应用已存在，请直接授权飞书账号。',
  'auth-profile-missing':'找不到此飞书应用配置。请先创建专用应用或核对已有配置名。',
  'auth-expired':'这次授权已结束或已过期，请重新发起。',
  'auth-denied':'飞书未批准这次授权。',
  'auth-pending':'尚未确认授权。请在飞书完成后再确认。',
  'auth-busy':'已有授权操作在进行，请先完成或取消。',
  'auth-setup-locked':'此专用应用可能正在创建。若先前已中断，请换一个未使用的专用配置名。',
  'scope-changed':'飞书身份已变更，请刷新后重新确认会话授权。',
  'admission-denied':'此会话或指定话题尚未获得人工授权。',
  'source-unavailable':'飞书同步未成功，请在来源页查看连接状态。',
})
export function publicFailure(e) {
  const code = e?.code
  return typeof code === 'string' && Object.hasOwn(messages,code)
    ? failure(code,messages[code]) : failure('unavailable','操作未完成，请刷新查看已保存的状态。')
}
