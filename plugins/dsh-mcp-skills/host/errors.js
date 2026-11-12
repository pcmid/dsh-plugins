/**
 * Result envelopes and the expected-failure error type of the Host API.
 * Failures carry `details: {}` because the Client Connection RPC parser requires an object there.
 */

/** Error codes of the Host API contract (docs/host-api.md). */
export const ERROR_CODES = new Set([
  'bad-request', 'not-found', 'exists', 'forbidden', 'invalid', 'git-failed', 'unavailable', 'internal',
])

/** An expected failure that becomes `{ ok: false, error: { code, message } }`. */
export class HostError extends Error {
  /**
   * @param {string} code - one of {@link ERROR_CODES}.
   * @param {string} message - user-facing English message naming the offending path or field.
   */
  constructor(code, message) {
    super(message)
    this.name = 'HostError'
    this.code = code
  }
}

/**
 * @param {unknown} value - operation value.
 * @returns {{ ok: true, value: unknown }} success result.
 */
export function ok(value) {
  return { ok: true, value }
}

/**
 * @param {string} code - error code.
 * @param {string} message - user-facing message.
 * @returns {{ ok: false, error: { code: string, message: string, details: object } }} failure result.
 */
export function failure(code, message) {
  return { ok: false, error: { code, message, details: {} } }
}

/**
 * Convert a thrown value into a failure result: {@link HostError} keeps its code, anything else is `internal`.
 * @param {unknown} error - thrown value.
 * @returns {ReturnType<typeof failure>} failure result.
 */
export function toFailure(error) {
  if (error instanceof HostError) return failure(error.code, error.message)
  return failure('internal', error instanceof Error ? error.message : String(error))
}

/**
 * @param {unknown} error - thrown value.
 * @returns {string} its message.
 */
export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
