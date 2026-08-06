import { createHash } from 'node:crypto'
import { customAlphabet } from 'nanoid'

const nano = customAlphabet('0123456789abcdefghjkmnpqrstvwxyz', 16)

export function newId(prefix: string): string {
  return `${prefix}_${nano()}`
}

export function now(): string {
  return new Date().toISOString()
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function j<T>(value: T): string {
  return JSON.stringify(value)
}

export function pj<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === '') return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x))
}

export function logit(p: number): number {
  const c = clamp(p, 0.02, 0.98)
  return Math.log(c / (1 - c))
}

export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x))
}

/** Wilson score lower bound for a proportion (z=1.96, 95%). Honest under small samples. */
export function wilsonLower(positive: number, n: number, z = 1.96): number {
  if (n <= 0) return 0
  const p = positive / n
  const z2 = z * z
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n)
}

export function daysBetween(aIso: string, bIso: string): number {
  return Math.abs(new Date(aIso).getTime() - new Date(bIso).getTime()) / 86_400_000
}
