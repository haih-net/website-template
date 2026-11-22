import { builder } from 'server/schema/builder'
import type { AudioTranscriptionRecord } from './interfaces'

export const AudioTranscription = builder
  .objectRef<AudioTranscriptionRecord>('AudioTranscription')
  .implement({
    fields: (t) => ({
      text: t.exposeString('text', { nullable: false }),
      language: t.exposeString('language', { nullable: false }),
      durationSeconds: t.exposeFloat('durationSeconds', { nullable: false }),
      completed: t.exposeBoolean('completed', { nullable: false }),
    }),
  })
