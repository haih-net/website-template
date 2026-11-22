import { afterEach, expect, it, vi } from 'vitest'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { connectCodex } from './connectCodex'

vi.mock('node:fs', () => ({ readFileSync: () => 'test-secret' }))
afterEach(() => vi.unstubAllEnvs())

it('разделяет встречные id, возвращает результаты только своей сессии и не подтверждает неизвестные инструменты', async () => {
  const server = new WebSocketServer({ port: 0 })
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Нет порта')
  }
  vi.stubEnv('CODEX_SERVER_URL', `ws://127.0.0.1:${address.port}`)
  vi.stubEnv('CODEX_TRANSPORT_TOKEN_FILE', 'test-token')
  const received: Array<{
    id?: string | number
    result?: unknown
    error?: { code: number }
  }> = []

  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString())
      if (message.method === 'initialize') {
        socket.send(JSON.stringify({ id: message.id, result: {} }))
      } else if (message.method === 'turn/start') {
        socket.send(
          JSON.stringify({
            id: message.id,
            method: 'currentTime/read',
            params: { threadId: 'own' },
          }),
        )
        socket.send(
          JSON.stringify({ id: message.id, result: { turn: 'correct' } }),
        )
        for (const [id, method, threadId] of [
          ['tool', 'item/tool/call', 'own'],
          ['foreign', 'currentTime/read', 'other'],
          ['unknown', 'unknown/method', 'own'],
          ['approval', 'item/commandExecution/requestApproval', 'own'],
        ]) {
          socket.send(JSON.stringify({ id, method, params: { threadId } }))
        }
      } else if (message.id !== undefined) {
        received.push(message)
      }
    })
  })
  const client = await connectCodex(() => 'own')
  try {
    expect(await client.request('turn/start', {})).toEqual({ turn: 'correct' })
    await vi.waitFor(() => expect(received).toHaveLength(5))
    expect(received[0].result).toEqual({ currentTimeAt: expect.any(Number) })
    expect(
      received.find((message) => message.id === 'tool')?.result,
    ).toMatchObject({ success: false })
    expect(
      received.find((message) => message.id === 'foreign')?.error?.code,
    ).toBe(-32602)
    expect(
      received.find((message) => message.id === 'unknown')?.error?.code,
    ).toBe(-32601)
    expect(
      received.find((message) => message.id === 'approval')?.result,
    ).toEqual({ decision: 'decline' })
  } finally {
    client.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
