// Каталог V3 закреплённой версии Codex; идентификаторы передаются без перевода.
export const codexVoices = [
  'juniper',
  'maple',
  'spruce',
  'ember',
  'vale',
  'breeze',
  'arbor',
  'sol',
  'cove',
  'aube',
  'bubbie',
  'haetsal',
  'hanul',
  'himari',
  'leher',
  'miko',
  'neer',
  'porto',
  'rindo',
  'rio',
  'rivage',
  'selva',
  'sonna',
  'tinta',
  'viola',
] as const

export type CodexVoice = (typeof codexVoices)[number]

export function isCodexVoice(value: unknown): value is CodexVoice {
  return (
    typeof value === 'string' && codexVoices.some((voice) => voice === value)
  )
}
