import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

export interface TranscriptSegment {
  id: string
  text: string
  revision: number
}

export interface TranscriptionResult {
  text: string
  segments: TranscriptSegment[]
  durationSeconds: number
  language: string
  backend: 'codex-desktop-dictation'
  completed: true
}

export const eventSchema = z.object({
  type: z.string(),
  utterance_id: z.string().nullish(),
  text: z.string().optional(),
  revision: z.number().optional(),
  session: z.object({ status: z.string() }).loose().optional(),
  error: z.object({ code: z.string(), message: z.string() }).loose().optional(),
})

// Порядок задаётся началом речи, а не скоростью завершения распознавания.
export class TranscriptCollector {
  private readonly segments = new Map<string, TranscriptSegment | null>()

  accept(event: z.infer<typeof eventSchema>): void {
    const id = event.utterance_id
    if (!id) {
      return
    }
    if (!this.segments.has(id)) {
      this.segments.set(id, null)
    }
    if (event.type !== 'transcript.final') {
      return
    }
    if (event.text === undefined || event.revision === undefined) {
      throw new Error('Сервис вернул некорректный финальный транскрипт')
    }
    const current = this.segments.get(id)
    if (!current || event.revision >= current.revision) {
      this.segments.set(id, { id, text: event.text, revision: event.revision })
    }
  }

  finish(): TranscriptSegment[] {
    const result: TranscriptSegment[] = []
    for (const segment of this.segments.values()) {
      if (segment === null) {
        throw new Error(
          'Сессия завершилась без финального текста для части речи',
        )
      }
      result.push(segment)
    }
    return result
  }
}

export async function readToken(): Promise<string> {
  const authPath =
    process.env.TRANSCRIBE_AUTH_FILE ??
    join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json')

  let raw: unknown
  try {
    raw = JSON.parse(await readFile(authPath, 'utf8'))
  } catch {
    throw new Error('Не удалось прочитать файл авторизации Codex')
  }
  const auth = z
    .object({ tokens: z.object({ access_token: z.string().min(1) }) })
    .safeParse(raw)

  if (!auth.success) {
    throw new Error('Нужна существующая файловая авторизация ChatGPT в Codex')
  }
  return auth.data.tokens.access_token
}
