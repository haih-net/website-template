import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { builder } from 'server/schema/builder'
import { codexChatSession } from 'server/schema/permissions/rules/hasCodexChatToken'
import { TranscribeAudioInput } from '../inputs'
import { AudioTranscription } from '../types'
import { transcribeAudio } from '../helpers/transcribeAudio'
import { acquireTranscription } from '../helpers/transcriptionSlots'

interface AudioUpload {
  createReadStream(): Readable
}

builder.mutationField('transcribeAudio', (t) =>
  t.field({
    authScopes: { codexChatToken: true },
    type: AudioTranscription,
    nullable: false,
    args: { data: t.arg({ type: TranscribeAudioInput, required: true }) },
    resolve: async (_, { data }, ctx) => {
      const sessionId = codexChatSession(ctx)
      if (!sessionId) {
        throw new Error('Недействительный токен чата')
      }
      const release = acquireTranscription(sessionId)
      const controller = new AbortController()
      const abort = (): void => controller.abort()
      ctx.req.on('aborted', abort)
      ctx.req.res?.on('close', abort)
      let directory: string | undefined
      try {
        const upload = await (data.file as Promise<AudioUpload>)
        directory = await mkdtemp(join(tmpdir(), 'website-transcription-'))
        const filePath = join(directory, 'audio')
        let size = 0
        const limit = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            size += chunk.length
            callback(
              size > 25 * 1024 * 1024
                ? new Error('Аудиофайл превышает 25 МиБ')
                : null,
              chunk,
            )
          },
        })

        await pipeline(
          upload.createReadStream(),
          limit,
          createWriteStream(filePath, { mode: 0o600 }),
          { signal: controller.signal },
        )
        return await transcribeAudio({
          filePath,
          language: data.language ?? 'ru',
          signal: controller.signal,
        })
      } finally {
        ctx.req.off('aborted', abort)
        ctx.req.res?.off('close', abort)
        release()
        if (directory) {
          await rm(directory, { recursive: true, force: true })
        }
      }
    },
  }),
)
