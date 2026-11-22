import WebSocket from 'ws'
import { readFileSync } from 'node:fs'

export interface CodexEvent {
  method: string
  params: {
    [key: string]: unknown
    threadId?: string
    delta?: string
    turn?: { id: string; status: string; error?: { message: string } }
  }
}

export function codexSecret(): string {
  const path = process.env.CODEX_TRANSPORT_TOKEN_FILE
  if (!path) {
    throw new Error('Не настроена авторизация сервера Codex')
  }
  return readFileSync(path, 'utf8').trim()
}

export interface CodexConnection {
  request<T>(method: string, params: object): Promise<T>
  onToolCall?: (params: CodexEvent['params']) => Promise<{
    success: boolean
    contentItems: { type: 'inputText'; text: string }[]
  }>
  onEvent?: (event: CodexEvent) => void
  onClose?: (error: Error) => void
  close(): void
}

export async function connectCodex(
  getThreadId: () => string | undefined = () => undefined,
): Promise<CodexConnection> {
  const url = process.env.CODEX_SERVER_URL
  if (!url) {
    throw new Error('Не настроен адрес сервера Codex')
  }
  const ws = new WebSocket(url, {
    headers: { Authorization: `Bearer ${codexSecret()}` },
    handshakeTimeout: 10000,
    maxPayload: 8 * 1024 * 1024,
  })

  let sequence = 0
  const pending = new Map<
    number,
    {
      resolve(value: unknown): void
      reject(error: Error): void
      timer: ReturnType<typeof setTimeout>
    }
  >()

  const client: CodexConnection = {
    request: <T>(method: string, params: object): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const id = ++sequence
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`Истекло время ожидания Codex: ${method}`))
        }, 30000)

        pending.set(id, {
          resolve: (value) => resolve(value as T),
          reject,
          timer,
        })
        ws.send(JSON.stringify({ id, method, params }), (error) => {
          if (error) {
            clearTimeout(timer)
            pending.delete(id)
            reject(error)
          }
        })
      }),
    close: () => {
      ws.close()
      const timer = setTimeout(() => ws.terminate(), 1000)
      timer.unref()
      ws.once('close', () => clearTimeout(timer))
    },
  }

  ws.on('message', (raw) => {
    try {
      const message = JSON.parse(raw.toString()) as CodexEvent & {
        id?: number | string
        result?: unknown
        error?: { message: string }
      }

      // Встречные запросы имеют собственное пространство id: сначала проверяем method.
      if (message.id !== undefined && message.method) {
        let response:
          { result: unknown } | { error: { code: number; message: string } }

        const threadId = getThreadId()
        if (!threadId || message.params?.threadId !== threadId) {
          response = {
            error: {
              code: -32602,
              message: 'Запрос не принадлежит активной сессии чата',
            },
          }
        } else if (message.method === 'currentTime/read') {
          response = {
            result: { currentTimeAt: Math.floor(Date.now() / 1000) },
          }
        } else if (message.method === 'item/tool/call' && client.onToolCall) {
          void client
            .onToolCall(message.params)
            .then((result) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ id: message.id, result }))
              }
            })
            .catch(() => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(
                  JSON.stringify({
                    id: message.id,
                    result: {
                      success: false,
                      contentItems: [
                        {
                          type: 'inputText',
                          text: 'Не удалось выполнить инструмент',
                        },
                      ],
                    },
                  }),
                )
              }
            })
          return
        } else if (message.method === 'item/tool/call') {
          response = {
            result: {
              success: false,
              contentItems: [
                {
                  type: 'inputText',
                  text: 'Запрошенный клиентский инструмент не зарегистрирован в этом чате.',
                },
              ],
            },
          }
        } else if (
          message.method === 'item/commandExecution/requestApproval' ||
          message.method === 'item/fileChange/requestApproval'
        ) {
          response = { result: { decision: 'decline' } }
        } else {
          response = {
            error: {
              code: -32601,
              message: `Метод клиента не поддерживается: ${message.method}`,
            },
          }
        }
        ws.send(JSON.stringify({ id: message.id, ...response }))
      } else if (
        typeof message.id === 'number' &&
        ('result' in message || 'error' in message)
      ) {
        const call = pending.get(message.id)
        if (call) {
          pending.delete(message.id)
          clearTimeout(call.timer)
          if (message.error) {
            call.reject(new Error(message.error.message))
          } else {
            call.resolve(message.result)
          }
        }
      } else if (message.id === undefined && message.method) {
        client.onEvent?.(message)
      }
    } catch {
      ws.close(1002, 'Invalid protocol')
    }
  })
  ws.on('close', () => {
    const error = new Error('Соединение с Codex закрыто')
    for (const call of pending.values()) {
      clearTimeout(call.timer)
      call.reject(error)
    }
    pending.clear()
    client.onClose?.(error)
  })
  ws.on('error', () => ws.close())
  try {
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    await client.request('initialize', {
      capabilities: { experimentalApi: true },
      clientInfo: {
        name: 'website-chat',
        title: 'Чат сайта',
        version: '1.0.0',
      },
    })
    ws.send(JSON.stringify({ method: 'initialized' }))
    return client
  } catch (error) {
    ws.terminate()
    throw error
  }
}
