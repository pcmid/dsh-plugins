#!/usr/bin/env node
/**
 * Builds index.json, a DSH plugin market index (format 1), from catalog.json.
 *
 * - A `path` entry is a plugin in this repository. It is listed at the last commit that touched its
 *   directory and installs from Git with that directory as `path`, so commit (and push) the plugin first.
 * - An `npm` entry is a third-party plugin pinned to one published version. Its display metadata is read
 *   from that version's tarball, whose integrity is checked against the registry.
 * - A `git` entry is a plugin in another Git repository, typically our fork of a third-party plugin, pinned
 *   to one `commit` (optionally a package directory `path`). It installs from Git, so the commit must carry
 *   the plugin's built files.
 *
 * Usage: node scripts/build-index.mjs [--check]
 *   --check  write nothing; exit 1 when index.json differs from the generated index.
 * The result is validated with DSH's own reader, @deepseek-ai/dsh-plugin-market-index, when it is installed
 * (`npm install`); --check requires it.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const INDEX_FILE = join(ROOT, 'index.json')
const DEFAULT_REGISTRY = 'https://registry.npmjs.org/'
/** DSH's limit for inline `data:` icons; larger icons are referenced by URL. */
const MAX_INLINE_ICON_BYTES = 32 * 1024
const ICON_TYPES = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }
const LANGUAGE_ID = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/u
const PATH_SEGMENT = /^[A-Za-z0-9._@+-]+$/u

const check = process.argv.includes('--check')

class BuildError extends Error {}

function fail(message) {
  throw new BuildError(message)
}

function warn(message) {
  console.warn(`warning: ${message}`)
}

function git(...args) {
  return gitIn(ROOT, ...args)
}

function gitIn(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** The value when it is a string with a non-whitespace character. */
function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function isPackagePath(value) {
  return value.split('/').every(segment => segment !== '.' && segment !== '..' && PATH_SEGMENT.test(segment))
}

// ---------------------------------------------------------------------------
// Display metadata, read the way DSH reads an installed plugin.
// ---------------------------------------------------------------------------

/** Relative target of export `key`: a string, or a conditions object's `default`/`import`. */
function exportTarget(manifest, key) {
  const value = manifest.exports?.[key]
  const target = typeof value === 'string' ? value : value?.default ?? value?.import
  return typeof target === 'string' ? target : undefined
}

/** Locale files matched by the `./locale/*.json` export, as `{ language, file }`. */
function localeFiles(dir, manifest) {
  const target = exportTarget(manifest, './locale/*.json')
  if (target === undefined || !target.includes('*')) return []
  const [prefix, suffix] = target.split('*')
  const folder = resolve(dir, dirname(`${prefix}_`))
  const namePrefix = basename(`${prefix}_`).slice(0, -1)
  if (!existsSync(folder)) return []
  return readdirSync(folder)
    .filter(name => name.startsWith(namePrefix) && name.endsWith(suffix) && name.length > namePrefix.length + suffix.length)
    .sort()
    .map(name => ({ language: name.slice(namePrefix.length, name.length - suffix.length), file: join(folder, name) }))
}

/** LocalizedText with `en` first; `fallback` supplies a missing `en`. */
function localized(byLanguage, fallback, what) {
  const languages = Object.keys(byLanguage)
  if (languages.length === 0) return fallback
  if (!Object.hasOwn(byLanguage, 'en')) {
    if (fallback === undefined) {
      warn(`${what} has no English text; listing the ${languages[0]} text without a language`)
      return byLanguage[languages[0]]
    }
    byLanguage = { en: fallback, ...byLanguage }
  }
  return Object.fromEntries(['en', ...languages.filter(language => language !== 'en').sort()].map(language => [language, byLanguage[language]]))
}

function displayText(dir, manifest) {
  const titles = {}
  const descriptions = {}
  for (const { language, file } of localeFiles(dir, manifest)) {
    if (!LANGUAGE_ID.test(language)) {
      warn(`${manifest.name}: ignoring locale file ${basename(file)}; its language id is not lowercase BCP 47`)
      continue
    }
    const meta = readJson(file).meta ?? {}
    if (text(meta.title)) titles[language] = meta.title
    if (text(meta.description)) descriptions[language] = meta.description
  }
  return {
    // Without any localized title the reader displays the package name itself.
    title: localized(titles, Object.keys(titles).length === 0 ? undefined : manifest.name, `${manifest.name} title`),
    description: localized(descriptions, text(manifest.description), `${manifest.name} description`),
  }
}

/**
 * The icon as an inline `data:` URL, or as `remoteUrl(relativePath)` when it exceeds the inline limit.
 * A top-level `icon` path takes priority over the `./icon` export, as in DSH.
 */
function iconValue(dir, manifest, remoteUrl) {
  const path = text(manifest.icon) ?? exportTarget(manifest, './icon')
  if (path === undefined) return undefined
  const file = resolve(dir, path)
  if (!file.startsWith(dir + sep)) fail(`${manifest.name}: icon ${path} leaves the package`)
  if (!existsSync(file)) {
    warn(`${manifest.name}: icon ${path} does not exist; listing without an icon`)
    return undefined
  }
  const type = ICON_TYPES[extname(file).toLowerCase()]
  if (type === undefined) {
    warn(`${manifest.name}: icon ${path} is not SVG, PNG, JPEG, or WebP; listing without an icon`)
    return undefined
  }
  const bytes = readFileSync(file)
  if (bytes.length <= MAX_INLINE_ICON_BYTES) return `data:${type};base64,${bytes.toString('base64')}`
  return remoteUrl(relative(dir, file).split(sep).join('/'))
}

/** npm author declaration → display name without contact fields. */
function authorName(author) {
  if (typeof author === 'object' && author !== null) return text(author.name)?.trim()
  if (typeof author !== 'string') return undefined
  return text(author.replace(/<[^>]*>/gu, '').replace(/\([^)]*\)/gu, '').trim())
}

/** npm repository declaration → web page URL and optional package directory. */
function repositoryOf(manifest) {
  const declared = manifest.repository
  const raw = text(typeof declared === 'string' ? declared : declared?.url)?.trim()
  if (raw === undefined) return undefined
  const hosts = { github: 'github.com', gitlab: 'gitlab.com', bitbucket: 'bitbucket.org' }
  const shorthand = /^(?:(github|gitlab|bitbucket):)?([\w.-]+)\/([\w.-]+)$/u.exec(raw)
  const candidate = shorthand
    ? `https://${hosts[shorthand[1] ?? 'github']}/${shorthand[2]}/${shorthand[3]}`
    : raw.replace(/^git\+/u, '').replace(/^git:\/\//u, 'https://').replace(/^ssh:\/\/git@/u, 'https://').replace(/^git@([^:]+):/u, 'https://$1/')
  if (!URL.canParse(candidate)) return undefined
  const url = new URL(candidate)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  url.pathname = url.pathname.replace(/\.git$/u, '').replace(/\/+$/u, '')
  const directory = typeof declared === 'object' ? text(declared?.directory) : undefined
  return { url: url.href, ...directory !== undefined && isPackagePath(directory) ? { directory } : {} }
}

function homepageOf(manifest) {
  const homepage = text(manifest.homepage)
  if (homepage === undefined || !URL.canParse(homepage)) return undefined
  return ['https:', 'http:'].includes(new URL(homepage).protocol) ? homepage : undefined
}

function requireBundle(manifest, where) {
  if (typeof manifest.dsh?.bundle?.patch !== 'string') fail(`${where}: package.json declares no dsh.bundle.patch, so DSH cannot install it as a bundle`)
}

/** One index plugin from its manifest, display metadata, catalog metadata, and single listed version. */
function pluginEntry(item, manifest, display, version, distTags) {
  const author = authorName(manifest.author)
  const homepage = homepageOf(manifest)
  const repository = repositoryOf(manifest)
  return {
    name: manifest.name,
    ...display.title === undefined ? {} : { title: display.title },
    ...display.description === undefined ? {} : { description: display.description },
    ...display.icon === undefined ? {} : { icon: display.icon },
    ...author === undefined ? {} : { author },
    ...homepage === undefined ? {} : { homepage },
    ...repository === undefined ? {} : { repository },
    metadata: {
      ...item.category === undefined ? {} : { category: item.category },
      keywords: Array.isArray(manifest.keywords) ? manifest.keywords.filter(keyword => typeof keyword === 'string') : [],
      labels: item.labels ?? [],
    },
    'dist-tags': distTags,
    versions: [version],
  }
}

// ---------------------------------------------------------------------------
// Plugins in this repository, installed from Git.
// ---------------------------------------------------------------------------

function githubOwnerRepo(repositoryUrl) {
  const url = new URL(repositoryUrl)
  return url.hostname === 'github.com' ? url.pathname.replace(/^\/|\.git$/gu, '') : undefined
}

function repositoryPlugin(item, catalog) {
  if (!isPackagePath(item.path)) fail(`catalog path ${item.path} must be a relative directory`)
  const dir = join(ROOT, item.path)
  const manifest = readJson(join(dir, 'package.json'))
  requireBundle(manifest, item.path)
  const range = text(manifest.engines?.dsh) ?? fail(`${item.path}/package.json must declare engines.dsh`)
  if (git('status', '--porcelain', '--untracked-files=all', '--', item.path) !== '') {
    fail(`${item.path} has uncommitted changes; commit them before building the index`)
  }
  const [commit, committedAt] = git('log', '-1', '--format=%H %ct', '--', item.path).split(' ')
  if (!commit) fail(`${item.path} has no commit yet`)
  if (git('branch', '-r', '--contains', commit) === '') warn(`${item.path}: commit ${commit.slice(0, 12)} is on no remote branch yet; push it before publishing the index`)
  const ownerRepo = githubOwnerRepo(catalog.repository)
  const icon = iconValue(dir, manifest, path => {
    if (ownerRepo === undefined) fail(`${manifest.name}: icon over ${MAX_INLINE_ICON_BYTES} bytes needs a GitHub repository to reference it`)
    return `https://cdn.jsdelivr.net/gh/${ownerRepo}@${commit}/${item.path}/${path}`
  })
  return pluginEntry(item, manifest, { ...displayText(dir, manifest), icon }, {
    version: manifest.version,
    publishTimestamp: Number(committedAt),
    source: { type: 'git', url: catalog.repository, commit, path: item.path },
    engines: { dsh: range },
  }, { latest: manifest.version })
}

// ---------------------------------------------------------------------------
// Third-party plugins, installed from npm.
// ---------------------------------------------------------------------------

async function fetchOk(url) {
  const response = await fetch(url)
  if (!response.ok) fail(`GET ${url} answered HTTP ${response.status}`)
  return response
}

function verifyIntegrity(bytes, dist, what) {
  const integrity = text(dist.integrity)?.split(/\s+/u).find(entry => entry.startsWith('sha512-'))
  if (integrity !== undefined) {
    if (createHash('sha512').update(bytes).digest('base64') !== integrity.slice('sha512-'.length)) fail(`${what}: tarball does not match its sha512 integrity`)
    return
  }
  if (text(dist.shasum) === undefined) fail(`${what}: registry lists no integrity or shasum`)
  if (createHash('sha1').update(bytes).digest('hex') !== dist.shasum) fail(`${what}: tarball does not match its shasum`)
}

async function npmPlugin(item) {
  const what = `${item.npm}@${item.version}`
  const registry = item.registry ?? DEFAULT_REGISTRY
  const packument = await (await fetchOk(new URL(item.npm.replace('/', '%2f'), registry))).json()
  const published = packument.versions?.[item.version] ?? fail(`${what} is not published on ${registry}`)
  const publishedAt = Date.parse(packument.time?.[item.version] ?? '')
  if (Number.isNaN(publishedAt)) fail(`${what}: registry lists no publish time`)
  const tarball = Buffer.from(await (await fetchOk(published.dist.tarball)).arrayBuffer())
  verifyIntegrity(tarball, published.dist, what)

  const scratch = mkdtempSync(join(tmpdir(), 'dsh-index-'))
  try {
    writeFileSync(join(scratch, 'package.tgz'), tarball)
    mkdirSync(join(scratch, 'x'))
    execFileSync('tar', ['-xzf', join(scratch, 'package.tgz'), '-C', join(scratch, 'x')])
    const [top] = readdirSync(join(scratch, 'x'))
    const dir = join(scratch, 'x', top)
    const manifest = readJson(join(dir, 'package.json'))
    if (manifest.name !== item.npm || manifest.version !== item.version) fail(`${what}: tarball declares ${manifest.name}@${manifest.version}`)
    requireBundle(manifest, what)
    const range = text(manifest.engines?.dsh)
    if (range === undefined) warn(`${what} declares no engines.dsh; listed without a DSH version range`)
    const icon = iconValue(dir, manifest, path => `https://cdn.jsdelivr.net/npm/${item.npm}@${item.version}/${path}`)
    const distTags = Object.fromEntries(Object.entries(packument['dist-tags'] ?? {}).filter(([, target]) => target === item.version))
    return pluginEntry(item, manifest, { ...displayText(dir, manifest), icon }, {
      version: item.version,
      publishTimestamp: Math.floor(publishedAt / 1000),
      source: { type: 'npm', ...item.registry === undefined ? {} : { registry: item.registry } },
      engines: range === undefined ? {} : { dsh: range },
    }, distTags)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// Plugins in other Git repositories, installed from Git.
// ---------------------------------------------------------------------------

const COMMIT = /^[0-9a-f]{40}$/u

function gitPlugin(item) {
  const what = `${item.git}#${item.commit}`
  if (!URL.canParse(item.git) || new URL(item.git).protocol !== 'https:') fail(`${what}: "git" must be an https repository URL`)
  if (!COMMIT.test(item.commit)) fail(`${what}: "commit" must be a full lowercase 40-hex-digit SHA`)
  if (item.path !== undefined && !isPackagePath(item.path)) fail(`${what}: path ${item.path} must be a relative directory`)
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-index-'))
  try {
    gitIn(scratch, 'init', '-q')
    try {
      gitIn(scratch, 'fetch', '-q', '--depth', '1', item.git, item.commit)
    } catch (error) {
      fail(`${what}: cannot fetch the commit (${String(error.stderr ?? error.message).trim()}); push it first`)
    }
    gitIn(scratch, 'checkout', '-q', 'FETCH_HEAD')
    const committedAt = gitIn(scratch, 'log', '-1', '--format=%ct', 'FETCH_HEAD')
    const dir = item.path === undefined ? scratch : join(scratch, item.path)
    const manifest = readJson(join(dir, 'package.json'))
    requireBundle(manifest, what)
    // DSH installs this commit as is, without a build step.
    for (const key of ['.', './client']) {
      const target = exportTarget(manifest, key)
      if (target !== undefined && !existsSync(resolve(dir, target))) fail(`${what}: export ${key} → ${target} is not in the commit; commit the built files`)
    }
    const range = text(manifest.engines?.dsh)
    if (range === undefined) warn(`${what} declares no engines.dsh; listed without a DSH version range`)
    const ownerRepo = githubOwnerRepo(item.git)
    const icon = iconValue(dir, manifest, path => {
      if (ownerRepo === undefined) fail(`${manifest.name}: icon over ${MAX_INLINE_ICON_BYTES} bytes needs a GitHub repository to reference it`)
      return `https://cdn.jsdelivr.net/gh/${ownerRepo}@${item.commit}/${item.path === undefined ? '' : `${item.path}/`}${path}`
    })
    return pluginEntry(item, manifest, { ...displayText(dir, manifest), icon }, {
      version: manifest.version,
      publishTimestamp: Number(committedAt),
      source: { type: 'git', url: item.git, commit: item.commit, ...item.path === undefined ? {} : { path: item.path } },
      engines: range === undefined ? {} : { dsh: range },
    }, { latest: manifest.version })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------

async function validate(index, indexUrl) {
  let reader
  try {
    reader = await import('@deepseek-ai/dsh-plugin-market-index')
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
    if (check) fail('--check needs @deepseek-ai/dsh-plugin-market-index; run npm install first')
    console.warn('note: validation skipped; run npm install to validate with DSH\'s index reader')
    return
  }
  try {
    reader.parseMarketIndex(index, indexUrl)
  } catch (error) {
    if (error instanceof reader.MarketIndexError) fail(`generated index is invalid: ${error.message}`)
    throw error
  }
  console.log('index validated with @deepseek-ai/dsh-plugin-market-index')
}

async function main() {
  const catalog = readJson(join(ROOT, 'catalog.json'))
  const plugins = []
  for (const item of catalog.plugins) {
    if (typeof item.path === 'string') plugins.push(repositoryPlugin(item, catalog))
    else if (typeof item.npm === 'string' && typeof item.version === 'string') plugins.push(await npmPlugin(item))
    else if (typeof item.git === 'string' && typeof item.commit === 'string') plugins.push(gitPlugin(item))
    else fail(`catalog entry ${JSON.stringify(item)} needs "path", "npm" with "version", or "git" with "commit"`)
  }
  const index = {
    format: 1,
    title: catalog.title,
    ...catalog.description === undefined ? {} : { description: catalog.description },
    metadata: catalog.metadata ?? {},
    plugins,
  }
  await validate(index, catalog.indexUrl)
  const body = `${JSON.stringify(index, null, 2)}\n`
  if (check) {
    const current = existsSync(INDEX_FILE) ? readFileSync(INDEX_FILE, 'utf8') : ''
    if (current !== body) fail('index.json is out of date; run npm run build:index and commit the result')
    console.log('index.json is up to date')
    return
  }
  writeFileSync(INDEX_FILE, body)
  console.log(`wrote ${relative(process.cwd(), INDEX_FILE) || INDEX_FILE} with ${plugins.length} plugins`)
}

try {
  await main()
} catch (error) {
  if (!(error instanceof BuildError)) throw error
  console.error(`error: ${error.message}`)
  process.exitCode = 1
}
