/**
 * Workspace-to-preset routing for `session.create`, free of Harness imports so
 * it runs under plain Node in tests.
 *
 * @module @pcmid/dsh-workspace-agent-preset/route
 */

/**
 * Compare directories as the Workspace registry stores them: trailing
 * separators are ignored, everything else must match exactly.
 * @param {string} path - absolute directory.
 * @returns {string} the directory without trailing separators (a root stays a root).
 */
export function normalizePath(path) {
  const trimmed = path.replace(/[\\/]+$/u, '')
  return trimmed === '' || /^[A-Za-z]:$/u.test(trimmed) ? path : trimmed
}

/**
 * Find the configured entry for one directory.
 * @param {unknown} workspaces - the `workspaces` Config value: directory → preset id.
 * @param {string} path - workspace directory.
 * @returns {{ key: string, preset: string } | undefined} the stored key and its preset, when one is set.
 */
export function lookup(workspaces, path) {
  if (workspaces === null || typeof workspaces !== 'object' || Array.isArray(workspaces)) return undefined
  const wanted = normalizePath(path)
  for (const [key, preset] of Object.entries(workspaces)) {
    if (typeof preset === 'string' && preset !== '' && normalizePath(key) === wanted) return { key, preset }
  }
  return undefined
}

/**
 * Give a creation request that names no preset its workspace's preset.
 *
 * A request that names a preset keeps it: the hero chip's staged pick,
 * Creator mode, and a restored blank all pass one explicitly. A preset that is
 * unknown or failed to activate is skipped with a warning, so the session
 * still opens under the global default instead of failing.
 * @param {object} request - `SessionCreateRequest` (`workspaceId` or `cwd`, optional `sessionId` and `agentPreset`).
 * @param {object} deps - lookups bound to the live Host services.
 * @param {() => unknown} deps.workspaces - current `workspaces` Config value.
 * @param {(workspaceId: string) => string | undefined} deps.workspacePath - Workspace directory by id.
 * @param {(preset: string) => Promise<string | undefined>} deps.problem - why a preset cannot compose a session, or undefined.
 * @param {(message: string) => void} deps.warn - Host log.
 * @returns {Promise<object>} the request to forward; the original object when nothing applies.
 */
export async function routeRequest(request, { workspaces, workspacePath, problem, warn }) {
  if (request === null || typeof request !== 'object' || request.agentPreset !== undefined) return request
  const path = request.workspaceId !== undefined ? workspacePath(request.workspaceId) : request.cwd
  if (typeof path !== 'string' || path === '') return request
  const entry = lookup(workspaces(), path)
  if (entry === undefined) return request
  const reason = await problem(entry.preset)
  if (reason !== undefined) {
    warn(`workspace-agent-preset: "${entry.preset}" for ${path} is unavailable, using the global default: ${reason}`)
    return request
  }
  return { ...request, agentPreset: entry.preset }
}

/**
 * Read a method from the prototype chain, skipping any own override.
 * @param {object} service - Service instance or its Cordis view.
 * @param {string} name - method name.
 * @returns {Function | undefined} the class method.
 */
function prototypeMethod(service, name) {
  for (let proto = Object.getPrototypeOf(service); proto !== null; proto = Object.getPrototypeOf(proto)) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name)
    if (descriptor !== undefined) return typeof descriptor.value === 'function' ? descriptor.value : undefined
  }
  return undefined
}

/**
 * Route `sessionController.create` through {@link routeRequest}.
 *
 * Harness resolves a preset-less creation to the global default inside the
 * Session controller and offers no hook in between, so the Remote method is
 * overridden on the instance, as `@pcmid/dsh-model-defaults` does for the
 * default model. The gateway reads the method from the Service at call time,
 * and the class method runs with the same receiver, so the call keeps its
 * invocation context. A routing failure forwards the original request.
 * @param {object} service - the `sessionController` Service.
 * @param {(request: object) => Promise<object>} route - request rewrite.
 * @param {(message: string) => void} warn - Host log.
 * @returns {() => void} the disposer restoring the class method.
 */
export function overrideCreate(service, route, warn) {
  const original = prototypeMethod(service, 'create')
  if (original === undefined) {
    warn('workspace-agent-preset: sessionController.create is missing; workspace presets are not applied')
    return () => {}
  }
  service.create = async function create(request) {
    let next = request
    try {
      next = await route(request)
    } catch (error) {
      warn(`workspace-agent-preset: routing failed, using the request as sent: ${String(error)}`)
    }
    return original.call(this, next)
  }
  return () => { delete service.create }
}
