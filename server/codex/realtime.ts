import { isCodexVoice } from '../../app/Custom/components/Chat/lib/codexVoices'
import type { Server } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { connectCodex, type CodexConnection } from './helpers/connectCodex'
import { verifySessionToken } from './helpers/sessionToken'
import { readSessionThread, saveSessionThread } from './helpers/sessionThread'
import { logDevError } from '../errorLogging'

export function setupCodexRealtime(
  server: Server,
  active: Set<string>,
): () => void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32768 })
  const onUpgrade = (
    req: import('node:http').IncomingMessage,
    socket: import('node:stream').Duplex,
    head: Buffer,
  ): void => {
    if (req.url?.split('?')[0] !== '/api/codex/voice') {
      return
    }
    let sameOrigin = false
    try {
      sameOrigin = new URL(req.headers.origin ?? '').host === req.headers.host
    } catch {
      /* Отсутствующий Origin запрещён. */
    }
    if (!sameOrigin) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws))
  }

  server.on('upgrade', onUpgrade)
  wss.on('connection', (socket) => {
    let client: CodexConnection | undefined
    let sessionId: string | undefined
    let threadId: string | undefined
    let starting = false
    let ready = false
    let closed = false
    let cleaning = false
    let stopping = false
    const send = (value: object): void => {
      if (socket.readyState === WebSocket.OPEN) {
        if (socket.bufferedAmount > 1024 * 1024) {
          socket.close(1013)
          return
        }
        socket.send(JSON.stringify(value))
      }
    }

    const cleanup = async (): Promise<void> => {
      if (cleaning) {
        return
      }
      cleaning = true
      ready = false
      clearTimeout(authTimeout)
      clearTimeout(startTimeout)
      clearInterval(heartbeat)
      if (client && threadId) {
        try {
          await client.request('thread/realtime/stop', { threadId })
        } catch (error) {
          logDevError('codex.voice.stop', error, { threadId })
        }
        try {
          await client.request('thread/unsubscribe', { threadId })
        } catch (error) {
          logDevError('codex.voice.unsubscribe', error, { threadId })
        }
      }
      closed = true
      client?.close()
      if (sessionId) {
        active.delete(sessionId)
      }
    }

    const fail = (error: unknown): void => {
      logDevError('codex.voice', error, { threadId })
      send({
        type: 'error',
        message:
          'Голосовой сервис Codex недоступен. Попробуйте включить его снова.',
      })
      socket.close(1011)
      void cleanup()
    }

    const authTimeout = setTimeout(() => socket.close(1008), 10000)
    const startTimeout = setTimeout(() => {
      if (!ready) {
        fail(new Error('Codex не подтвердил запуск голосового режима'))
      }
    }, 45000)

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
      void cleanup()
    })
    socket.on('error', fail)
    socket.on('message', (raw, binary) => {
      if (closed || stopping) {
        return
      }
      if (binary) {
        socket.close(1008)
        return
      }
      let packet: {
        type?: string
        token?: string
        sdp?: string
        voice?: unknown
      }

      try {
        packet = JSON.parse(raw.toString()) as typeof packet
      } catch {
        socket.close(1008)
        return
      }
      if (!packet || typeof packet !== 'object') {
        socket.close(1008)
        return
      }
      if (packet.type === 'stop') {
        stopping = true
        void cleanup().finally(() => socket.close(1000))
        return
      }
      if (
        packet.type !== 'start' ||
        starting ||
        typeof packet.sdp !== 'string' ||
        !packet.sdp.startsWith('v=0') ||
        packet.sdp.length > 20000
      ) {
        socket.close(1008)
        return
      }
      if (packet.voice !== undefined && !isCodexVoice(packet.voice)) {
        send({
          type: 'error',
          message: 'Выберите голос из списка доступных голосов.',
        })
        socket.close(1008)
        return
      }
      starting = true
      const id =
        typeof packet.token === 'string'
          ? verifySessionToken(packet.token)
          : null

      if (!id) {
        send({
          type: 'error',
          message: 'Сессия чата истекла. Обновите страницу.',
          code: 'INVALID_DIALOG_TOKEN',
        })
        socket.close(1008)
        return
      }
      if (active.has(id)) {
        send({
          type: 'error',
          message:
            'Сначала завершите текущий ответ или другой голосовой сеанс.',
        })
        socket.close(1008)
        return
      }
      sessionId = id
      active.add(id)
      clearTimeout(authTimeout)
      void (async () => {
        client = await connectCodex(() => threadId)
        if (closed) {
          client.close()
          return
        }
        client.onClose = (error) => {
          if (!closed) {
            fail(error)
          }
        }
        threadId = (await readSessionThread(id)) ?? undefined
        if (threadId) {
          await client.request('thread/resume', {
            threadId,
            excludeTurns: true,
          })
        } else {
          const result = await client.request<{ thread: { id: string } }>(
            'thread/start',
            {
              cwd: '/codex/workspace',
              approvalPolicy: 'never',
              sandbox: 'read-only',
              baseInstructions: '',
              developerInstructions: '',
              ephemeral: false,
            },
          )

          threadId = result.thread.id
          await saveSessionThread(id, threadId)
        }
        if (closed) {
          client.close()
          return
        }
        client.onEvent = (event) => {
          if (event.params.threadId !== threadId || closed) {
            return
          }
          send({ type: 'event', event })
          if (event.method === 'thread/realtime/started') {
            ready = true
            clearTimeout(startTimeout)
            send({ type: 'ready' })
          }
          if (event.method === 'thread/realtime/error') {
            fail(
              new Error(
                String(
                  event.params.message ?? 'Ошибка голосового сервиса Codex',
                ),
              ),
            )
          }
          if (event.method === 'thread/realtime/closed' && !cleaning) {
            socket.close(1000)
            void cleanup()
          }
        }
        await client.request('thread/realtime/start', {
          threadId,
          version: 'v3',
          ...(packet.voice === undefined ? {} : { voice: packet.voice }),
          outputModality: 'audio',
          transport: { type: 'webrtc', sdp: packet.sdp },
          clientManagedHandoffs: false,
          flushTranscriptTailOnSessionEnd: true,
          // initialItems: [
          //   {
          //     role: 'developer',
          //     text: 'Разговор ведётся на русском языке. Отвечай по-русски, если пользователь явно не попросил другой язык. Если речь неразборчива, попроси повторить, не придумывай смысл.',
          //   },
          // ],
        })
      })().catch(fail)
    })
  })
  return () => {
    server.off('upgrade', onUpgrade)
    for (const socket of wss.clients) {
      socket.terminate()
    }
    wss.close()
  }
}
