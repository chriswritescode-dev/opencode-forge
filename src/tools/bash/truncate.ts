import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

export const MAX_LINES = 2000
export const MAX_BYTES = 50 * 1024

export interface Limits { maxLines: number; maxBytes: number }

export function tail(text: string, maxLines: number, maxBytes: number): { text: string; cut: boolean } {
  const lines = text.split('\n')
  if (lines.length <= maxLines && Buffer.byteLength(text, 'utf-8') <= maxBytes) {
    return { text, cut: false }
  }
  const out: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i], 'utf-8') + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      if (out.length === 0) {
        const buf = Buffer.from(lines[i], 'utf-8')
        let start = buf.length - maxBytes
        if (start < 0) start = 0
        while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
        out.unshift(buf.subarray(start).toString('utf-8'))
      }
      break
    }
    out.unshift(lines[i])
    bytes += size
  }
  return { text: out.join('\n'), cut: true }
}

export function writeOverflow(dataDir: string, callID: string, text: string): string {
  const dir = join(dataDir, 'bash-output')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${callID}-${Date.now()}.txt`)
  writeFileSync(file, text, 'utf-8')
  return file
}
