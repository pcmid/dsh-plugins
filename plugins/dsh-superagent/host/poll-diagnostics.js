import { z } from 'zod'

const stage = z.enum(['identity','search','metadata','group','message','history','admission','storage','receive','poll'])
const reason = z.enum(['cli-not-found','cli-not-executable','timeout','login-required','permission-denied',
  'invalid-parameters','rate-limited','network','api-error','identity-mismatch','invalid-response',
  'storage-unavailable','admission-denied','context-too-large','cli-failed','unknown'])
const larkCode = z.int().positive().max(2147483647)
export const pollLog = z.strictObject({at:z.int().positive().max(8640000000000000),stage,reason,larkCode:larkCode.optional()})
const validCode = code => larkCode.safeParse(code).success

function localReason(error) {
  switch (error?.code) {
    case 'ENOENT': case 'ENOTDIR': return 'cli-not-found'
    case 'EACCES': case 'EPERM': case 'ENOEXEC': case 'invalid-cli-path': return 'cli-not-executable'
    case 'ETIMEDOUT': return 'timeout'
    case 'ECONNRESET': case 'ECONNREFUSED': case 'ENOTFOUND': case 'EHOSTUNREACH': return 'network'
    case 'admission-denied': return 'admission-denied'
    case 'storage-unavailable': return 'storage-unavailable'
  }
  return error?.killed && error.signal === 'SIGTERM' ? 'timeout' : undefined
}

// Only typed fields and numeric provider codes enter the classification. CLI messages, hints, args,
// URLs and nested provider payloads can contain personal identifiers and complete message bodies.
export function cliProblem(error,envelope) {
  const e = envelope?.ok === false && envelope.error || {}
  const code = validCode(e.code) ? e.code : undefined
  const subtype = e.subtype, type = e.type
  let why = localReason(error)
  if (!why) {
    if (['missing_scope','permission_denied','forbidden'].includes(subtype) || code === 99991679 || code === 99991672) why='permission-denied'
    else if (['not_configured','not_logged_in','token_expired','invalid_token','user_auth_required','token_invalid'].includes(subtype) ||
      ['authentication','auth'].includes(type)) why='login-required'
    else if (['invalid_argument','invalid_param','invalid_parameter','invalid_parameters','missing_argument'].includes(subtype) ||
      type === 'validation' || code === 99992402) why='invalid-parameters'
    else if (subtype === 'rate_limited' || type === 'rate_limit' || code === 99991400) why='rate-limited'
    else if (subtype === 'timeout' || type === 'timeout') why='timeout'
    else if (type === 'network' || subtype === 'network_error') why='network'
    else if (type === 'authorization') why='permission-denied'
    else why=type === 'api' || code !== undefined ? 'api-error' : 'cli-failed'
  }
  return {reason:why,...(code === undefined ? {} : {larkCode:code})}
}

export function pollDiagnostic(error,fallbackStage) {
  const local=localReason(error)
  return {at:Date.now(),
    stage:stage.safeParse(error?.stage).success ? error.stage :
      local === 'storage-unavailable' ? 'storage' : local === 'admission-denied' ? 'admission' :
      stage.safeParse(fallbackStage).success ? fallbackStage : 'poll',
    reason:reason.safeParse(error?.reason).success ? error.reason : local ?? 'unknown',
    ...(validCode(error?.larkCode) ? {larkCode:error.larkCode} : {})}
}
