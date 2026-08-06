import { Jieba } from '@node-rs/jieba'
import { dict } from '@node-rs/jieba/dict.js'

const jieba = Jieba.withDict(dict)

/** Segment text for FTS indexing/querying. cutForSearch emits both coarse and fine granularity. */
export function segment(text: string): string[] {
  return jieba
    .cutForSearch(text, true)
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length > 0 && !/^[\s\p{P}]+$/u.test(w))
}

export function toFtsDoc(text: string): string {
  return segment(text).join(' ')
}

/** Build an OR match query, quoting each term to keep FTS syntax safe. */
export function toFtsQuery(query: string): string {
  const terms = [...new Set(segment(query))].filter((t) => !/^["']+$/.test(t))
  return terms.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ')
}
