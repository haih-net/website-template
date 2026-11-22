import type { Express } from 'express'
import type { Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import { z } from 'zod'
import { verifySessionToken } from '../codex/helpers/sessionToken'
import { activeCodexSessions } from '../codex'
import {
  openDictation,
  type DictationConnection,
} from '../schema/types/AudioTranscription/helpers/openDictation'
import { acquireTranscription } from '../schema/types/AudioTranscription/helpers/transcriptionSlots'
import { VoiceAgent } from './agent'
import { synthesizeSpeech } from './synthesizeSpeech'
import { voiceMode } from './config'
import { logDevError } from '../errorLogging'

const packetSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start'), token: z.string().max(4096) }),
  z.object({ type: z.literal('record'), continuous: z.boolean() }),
  z.object({
    type: z.literal('finish'),
    action: z.enum(['insert', 'send']),
    prefix: z.string().max(16000).optional(),
  }),
  z.object({ type: z.literal('message'), text: z.string().min(1).max(16000) }),
  z.object({ type: z.literal('cancel') }),
  z.object({
    type: z.literal('playback'),
    id: z.uuid(),
    generation: z.number().int().nonnegative(),
    status: z.enum(['playing', 'ended', 'interrupted']),
    playedMs: z.number().int().min(0).max(600000),
  }),
  z.object({ type: z.literal('interrupt') }),
  z.object({ type: z.literal('mute'), value: z.boolean() }),
])

export function setupVoice(app: Express, server: Server): () => void {
  const mode = voiceMode()
  app.get('/api/voice/config', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.json({ mode })
  })
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 })
  server.on('upgrade', (req, socket, head) => {
    if (req.url?.split('?')[0] !== '/api/voice/messages') {
      return
    }
    let sameOrigin = false
    try {
      sameOrigin = new URL(req.headers.origin ?? '').host === req.headers.host
    } catch {
      /* Нет Origin — нет голосового подключения. */
    }
    if (!sameOrigin || mode !== 'messages') {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws))
  })
  wss.on('connection', (socket) => {
    let sessionId: string | undefined
    let agent: VoiceAgent | undefined
    let dictation: DictationConnection | undefined
    let release: (() => void) | undefined
    let closed = false
    let authenticating = false
    let connected = false
    let recordEpoch = 0
    let recording = false
    let finishing = false
    let sendAfterFinish = false
    let sendPrefix = ''
    let continuous = false
    let muted = false
    let generation = 0
    let speechQueue = Promise.resolve()
    let pendingSpeech = 0
    let speechAbort = new AbortController()
    const playback = new Map<
      string,
      { generation: number; text: string; status: string; playedMs: number }
    >()

    const segments = new Map<
      string,
      { text?: string; revision: number; sent: boolean; speaking: boolean }
    >()

    const send = (event: object): void => {
      if (closed || socket.readyState !== WebSocket.OPEN) {
        return
      }
      if (socket.bufferedAmount > 4 * 1024 * 1024) {
        socket.close(1013)
        return
      }
      socket.send(JSON.stringify(event))
    }

    const report = (error: unknown): void => {
      logDevError('voice.messages', error)
      send({
        type: 'error',
        message:
          error instanceof Error ? error.message : 'Ошибка голосового сервиса',
      })
    }

    const silence = (): void => {
      generation += 1
      speechAbort.abort()
      speechAbort = new AbortController()
      agent?.silence()
      send({ type: 'silence', generation })
    }

    const submit = async (text: string): Promise<void> => {
      silence()
      await agent?.submit(text)
    }

    const flush = (): void => {
      if (
        !continuous ||
        finishing ||
        [...segments.values()].some((segment) => segment.speaking)
      ) {
        return
      }
      const ready: string[] = []
      for (const segment of segments.values()) {
        if (segment.sent) {
          continue
        }
        if (segment.text === undefined) {
          return
        }
        ready.push(segment.text)
      }
      if (!ready.length) {
        return
      }
      const text = ready.join(' ').trim()
      if (!text) {
        return
      }
      for (const segment of segments.values()) {
        segment.sent = true
      }
      void submit(text).catch(report)
    }

    const resetRecording = (): void => {
      recordEpoch += 1
      recording = false
      finishing = false
      dictation?.close()
      dictation = undefined
      release?.()
      release = undefined
      send({ type: 'recording', value: false })
    }

    const timeout = setTimeout(() => socket.close(1008), 10000)
    let alive = true
    const heartbeat = setInterval(() => {
      if (!alive) {
        socket.terminate()
        return
      }
      alive = false
      socket.ping()
    }, 30000)

    socket.on('pong', () => {
      alive = true
    })
    socket.on('close', () => {
      closed = true
      clearTimeout(timeout)
      clearInterval(heartbeat)
      speechAbort.abort()
      resetRecording()
      void agent
        ?.close()
        .catch((error) => logDevError('voice.close', error))
        .finally(() => {
          if (sessionId) {
            activeCodexSessions.delete(sessionId)
          }
        })
      if (!agent && sessionId) {
        activeCodexSessions.delete(sessionId)
      }
    })
    socket.on('error', report)
    socket.on('message', (raw, binary) => {
      if (closed) {
        return
      }
      if (binary) {
        try {
          if (!dictation || finishing) {
            throw new Error('Запись ещё не готова')
          }
          dictation.append(
            Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer),
          )
        } catch (error) {
          resetRecording()
          report(error)
        }
        return
      }
      void (async () => {
        const packet = packetSchema.parse(JSON.parse(raw.toString()))
        if (packet.type === 'start') {
          if (sessionId || authenticating) {
            throw new Error('Сессия уже запущена')
          }
          authenticating = true
          const verified = verifySessionToken(packet.token)
          if (!verified || activeCodexSessions.has(verified)) {
            throw new Error('Недействительный или занятый токен чата')
          }
          sessionId = verified
          activeCodexSessions.add(sessionId)
          clearTimeout(timeout)
          agent = new VoiceAgent(sessionId, {
            send,
            generation: () => generation,
            speakingEnabled: () => !muted,
            disconnect: () => socket.close(1011),
            playbackContext: () =>
              `Состояние проигрывателя браузера (это не доказательство, что человек услышал звук). playing — начал, ended — завершил, interrupted — остановлен; playedMs не определяет точную границу слов. Остальные реплики могли не прозвучать. ${JSON.stringify([...playback.values()])}`,
            speak: (text, requestedGeneration) => {
              if (muted || requestedGeneration !== generation) {
                return
              }
              if (pendingSpeech >= 8) {
                send({
                  type: 'notice',
                  message:
                    'Очередь озвучки заполнена. Продолжение ответа доступно текстом.',
                })
                return
              }
              const controller = speechAbort
              pendingSpeech += 1
              speechQueue = speechQueue
                .then(async () => {
                  if (controller.signal.aborted || closed) {
                    return
                  }
                  const id = randomUUID()
                  const oldest = playback.keys().next().value
                  if (playback.size >= 12 && oldest) {
                    playback.delete(oldest)
                  }
                  playback.set(id, {
                    generation: requestedGeneration,
                    text,
                    status: 'queued',
                    playedMs: 0,
                  })
                  send({
                    type: 'audio-start',
                    id,
                    generation: requestedGeneration,
                    text,
                  })
                  await synthesizeSpeech(
                    text,
                    controller.signal,
                    (chunk) =>
                      new Promise<void>((resolve, reject) => {
                        if (
                          controller.signal.aborted ||
                          socket.readyState !== WebSocket.OPEN ||
                          socket.bufferedAmount > 4 * 1024 * 1024
                        ) {
                          reject(new Error('Воспроизведение остановлено'))
                          return
                        }
                        socket.send(
                          JSON.stringify({
                            type: 'audio',
                            id,
                            generation: requestedGeneration,
                            data: Buffer.from(chunk).toString('base64'),
                          }),
                          (error) => (error ? reject(error) : resolve()),
                        )
                      }),
                  )
                  send({
                    type: 'audio-end',
                    id,
                    generation: requestedGeneration,
                  })
                })
                .catch((error) => {
                  if (!controller.signal.aborted) {
                    silence()
                    report(error)
                  }
                })
                .finally(() => {
                  pendingSpeech -= 1
                })
            },
          })
          await agent.connect()
          if (closed) {
            await agent.close()
            return
          }
          connected = true
          send({ type: 'ready' })
          return
        }
        if (!agent || !sessionId || !connected) {
          throw new Error('Сначала авторизуйте голосовой чат')
        }
        if (packet.type === 'playback') {
          const portion = playback.get(packet.id)
          if (
            portion?.generation === packet.generation &&
            portion.status !== 'ended' &&
            portion.status !== 'interrupted'
          ) {
            portion.status = packet.status
            portion.playedMs = packet.playedMs
          }
          return
        }
        if (packet.type === 'message') {
          await submit(packet.text)
          return
        }
        if (packet.type === 'mute') {
          muted = packet.value
          if (muted) {
            silence()
          }
          return
        }
        if (packet.type === 'interrupt') {
          silence()
          await agent.interrupt()
          return
        }
        if (packet.type === 'cancel') {
          resetRecording()
          send({ type: 'draft', text: '' })
          return
        }
        if (packet.type === 'finish') {
          sendAfterFinish ||= packet.action === 'send'
          if (packet.action === 'send') {
            sendPrefix = packet.prefix ?? ''
          }
          if (finishing) {
            return
          }
          if (!dictation) {
            throw new Error('Нет активной записи')
          }
          finishing = true
          send({ type: 'finalizing' })
          const current = dictation
          const text = await current.finish()
          if (dictation !== current || closed) {
            return
          }
          const unsent = continuous
            ? [...segments.values()]
                .filter((s) => !s.sent)
                .map((s) => s.text ?? '')
                .join(' ')
                .trim()
            : text

          const shouldSend = sendAfterFinish || continuous
          resetRecording()
          const message = [sendPrefix, unsent].filter(Boolean).join('\n')
          if (shouldSend && message) {
            await submit(message)
          } else {
            send({ type: 'draft', text: unsent })
          }
          return
        }
        if (packet.type === 'record') {
          if (recording || finishing) {
            throw new Error('Запись уже идёт')
          }
          release = acquireTranscription(sessionId)
          recording = true
          continuous = packet.continuous
          sendAfterFinish = false
          sendPrefix = ''
          segments.clear()
          const epoch = ++recordEpoch
          const current = await openDictation(
            (event) => {
              if (!recording || recordEpoch !== epoch) {
                return
              }
              if (event.utterance_id) {
                const segment = segments.get(event.utterance_id) ?? {
                  revision: -1,
                  sent: false,
                  speaking: false,
                }

                if (event.type === 'speech.started') {
                  segment.speaking = true
                  silence()
                }
                if (event.type === 'speech.stopped') {
                  segment.speaking = false
                }
                if (
                  event.type === 'transcript.final' &&
                  (event.revision ?? -1) >= segment.revision
                ) {
                  segment.text = event.text ?? ''
                  segment.revision = event.revision ?? 0
                }
                segments.set(event.utterance_id, segment)
                flush()
              }
              send({ type: 'dictation', event })
            },
            (error) => {
              if (recordEpoch === epoch) {
                resetRecording()
                report(error)
              }
            },
          )

          if (closed || !recording || recordEpoch !== epoch) {
            current.close()
            return
          }
          dictation = current
          send({ type: 'recording', value: true })
        }
      })().catch((error) => {
        if (!dictation) {
          resetRecording()
        }
        report(error)
        if (authenticating && !connected) {
          socket.close(1011)
        }
      })
    })
  })
  return () => {
    for (const client of wss.clients) {
      client.close(1001)
    }
    wss.close()
  }
}
