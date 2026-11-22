import { z } from 'zod'
import type { TranscriptSegment } from './dictationProtocol'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import {
  eventSchema,
  readToken,
  TranscriptCollector,
} from './dictationProtocol'

export interface DictationEvent {
  type: string
  utterance_id?: string | null
  text?: string
  revision?: number
}

export interface DictationConnection {
  append(audio: Buffer): void
  finish(): Promise<string>
  segments(): TranscriptSegment[]
  close(): void
}

/** Живой PCM16 mono 24 kHz; VAD работает на стороне сервиса диктовки. */
export async function openDictation(
  onEvent: (event: DictationEvent) => void,
  onError: (error: Error) => void,
  language = 'ru',
): Promise<DictationConnection> {
  z.string()
    .regex(/^[a-z]{2,3}$/)
    .parse(language)
  const token = await readToken()
  const socket = new WebSocket(
    'wss://chatgpt.com/backend-api/dictation/stream?client_type=desktop&dictation_surface=composer',
    ['chatgpt-dictation', `openai-bearer.${token}`, 'codex-desktop'],
    { handshakeTimeout: 15000, maxPayload: 4 * 1024 * 1024 },
  )

  const collector = new TranscriptCollector()
  let bytes = 0
  let closed = false
  let finishing = false
  let ready = false
  let resolveReady: () => void = () => undefined
  let rejectReady: (error: Error) => void = () => undefined
  let resolveFinal: (text: string) => void = () => undefined
  let rejectFinal: (error: Error) => void = () => undefined
  const started = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })

  const final = new Promise<string>((resolve, reject) => {
    resolveFinal = resolve
    rejectFinal = reject
  })

  void final.catch(() => undefined)
  let timer = setTimeout(
    () => fail(new Error('Сервис не подтвердил начало диктовки')),
    20000,
  )

  const close = (): void => {
    closed = true
    clearTimeout(timer)
    socket.terminate()
  }

  const fail = (error: Error): void => {
    if (closed) {
      return
    }
    close()
    rejectReady(error)
    rejectFinal(error)
    onError(error)
  }

  const send = (event: object): void => {
    if (
      socket.readyState !== WebSocket.OPEN ||
      socket.bufferedAmount > 1024 * 1024
    ) {
      throw new Error('Сервис диктовки не успевает принимать аудио')
    }
    socket.send(JSON.stringify(event))
  }

  socket.on('open', () => {
    send({
      type: 'session.start',
      dictation_session_id: randomUUID(),
      attempt_id: randomUUID(),
      config: {
        language,
        input_audio_format: 'pcm16',
        sample_rate_hz: 24000,
        num_channels: 1,
        max_buffer_size_bytes: 4194304,
        max_utterance_duration_ms: 30000,
        session_ttl_ms: 300000,
        provider_mode: 'streaming_sse',
        transcript_delivery_mode: 'segment',
        vad: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
        },
      },
    })
  })
  socket.on('message', (raw) => {
    if (closed) {
      return
    }
    try {
      const event = eventSchema.parse(JSON.parse(raw.toString()))
      if (
        [
          'session.error',
          'transcript.failed',
          'session.stop_requested',
        ].includes(event.type)
      ) {
        throw new Error(
          `Сервис диктовки остановлен: ${event.error?.code ?? event.type}`,
        )
      }
      collector.accept(event)
      if (event.type === 'session.started') {
        ready = true
        clearTimeout(timer)
        timer = setTimeout(
          () => fail(new Error('Достигнут предел записи: 240 секунд')),
          250000,
        )
        resolveReady()
      }
      if (
        event.type === 'session.updated' &&
        event.session?.status === 'closed'
      ) {
        if (!finishing) {
          throw new Error('Сервис завершил запись раньше времени')
        }
        const text = collector
          .finish()
          .map((segment) => segment.text)
          .join(' ')
          .trim()

        close()
        resolveFinal(text)
        return
      }
      onEvent(event)
    } catch (error) {
      fail(
        error instanceof Error
          ? error
          : new Error('Некорректный ответ диктовки'),
      )
    }
  })
  socket.on('unexpected-response', (_request, response) => {
    response.resume()
    fail(
      new Error(
        `Сервис диктовки отклонил подключение: HTTP ${response.statusCode}`,
      ),
    )
  })
  socket.on('error', () => fail(new Error('Ошибка соединения диктовки')))
  socket.on('close', () =>
    fail(new Error('Диктовка закрыта без окончательного результата')),
  )
  await started
  return {
    append(audio) {
      if (!ready || closed || finishing) {
        throw new Error('Диктовка не готова')
      }
      bytes += audio.length
      if (audio.length % 2 || bytes > 240 * 48000) {
        throw new Error('Превышен предел аудиозаписи')
      }
      send({ type: 'audio.append', audio: audio.toString('base64') })
    },
    finish() {
      if (!finishing && !closed) {
        finishing = true
        clearTimeout(timer)
        timer = setTimeout(
          () => fail(new Error('Не получен окончательный текст диктовки')),
          70000,
        )
        send({
          type: 'audio.append',
          audio: Buffer.alloc(12000).toString('base64'),
        })
        send({ type: 'session.close' })
      }
      return final
    },
    segments: () => collector.finish(),
    close() {
      if (!closed) {
        rejectFinal(new Error('Диктовка отменена'))
        close()
      }
    },
  }
}
