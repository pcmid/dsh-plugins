// Decodes QR codes produced by the settings page encoder with jsQR across many payload lengths.
// Usage: JSQR=/path/to/jsQR.js node --test test/qr.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const start = source.indexOf('const ECC_PER_BLOCK_M')
const end = source.indexOf('function QrCode')
const encodeQr = new Function(`${source.slice(start, end)}\nreturn encodeQr`)()
const jsQR = createRequire(import.meta.url)(process.env.JSQR ?? '/tmp/qrv/jsqr-1.4.0/dist/jsQR.js')

function decode(modules) {
  const scale = 4
  const quiet = 4
  const size = (modules.length + quiet * 2) * scale
  const pixels = new Uint8ClampedArray(size * size * 4).fill(255)
  modules.forEach((row, y) => row.forEach((dark, x) => {
    if (!dark) return
    for (let dy = 0; dy < scale; dy += 1) {
      for (let dx = 0; dx < scale; dx += 1) {
        const offset = (((y + quiet) * scale + dy) * size + (x + quiet) * scale + dx) * 4
        pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 0
      }
    }
  }))
  return jsQR(pixels, size, size)?.data
}

test('encoded QR codes decode to the original text', () => {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_=&#:/.'
  for (const length of [1, 10, 14, 15, 30, 60, 100, 134, 160, 200, 213, 230, 251, 287, 300, 331, 400, 500, 700, 1000]) {
    let text = 'https://remote.example.com/#'
    while (text.length < length) text += alphabet[(text.length * 7) % alphabet.length]
    text = text.slice(0, length)
    const modules = encodeQr(text)
    assert.equal(decode(modules), text, `length ${length}, version ${(modules.length - 17) / 4}`)
  }
  assert.equal(decode(encodeQr('配对 DSH')), '配对 DSH')
})
