import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { setupCodexRealtime } from './realtime'
import { connectCodex, type CodexConnection } from './helpers/connectCodex'

vi.mock('./helpers/connectCodex', () => ({ connectCodex: vi.fn() }))
vi.mock('./helpers/sessionToken', () => ({
  verifySessionToken: (token: string) => (token === 'valid' ? 'session' : null),
}))
vi.mock('./helpers/sessionThread', () => ({
  readSessionThread: async () => 'thread',
  saveSessionThread: vi.fn(),
}))

let server: Server
let stop: () => void
let url: string
let origin: string
let active: Set<string>
let client: CodexConnection
const calls: Array<{ method: string; params: object }> = []
const sockets: WebSocket[] = []

beforeEach(async () => {
  calls.length = 0
  active = new Set()
  client = {
    request: async <T>(method: string, params: object): Promise<T> => {
      calls.push({ method, params })
      if (method === 'thread/realtime/start') {
        client.onEvent?.({
          method: 'thread/realtime/started',
          params: { threadId: 'thread' },
        })
      }
      if (method === 'thread/realtime/stop') {
        client.onEvent?.({
          method: 'thread/realtime/item/completed',
          params: {
            threadId: 'thread',
            item: {
              id: 'tail',
              type: 'transcriptSegment',
              role: 'user',
              text: 'Последняя реплика',
            },
          },
        })
      }
      return {} as T
    },
    close: vi.fn(),
  }
  vi.mocked(connectCodex).mockResolvedValue(client)
  server = createServer()
  stop = setupCodexRealtime(server, active)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Нет адреса сервера')
  }
  origin = `http://127.0.0.1:${address.port}`
  url = `ws://127.0.0.1:${address.port}/api/codex/voice`
})

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.terminate()
  }
  stop()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  vi.clearAllMocks()
})

async function open(token: string): Promise<{
  socket: WebSocket
  packets: Array<{ type: string; message?: string; event?: { method: string } }>
}> {
  const socket = new WebSocket(url, { origin })
  sockets.push(socket)
  const packets: Array<{
    type: string
    message?: string
    event?: { method: string }
  }> = []

  socket.on('message', (data) =>
    packets.push(JSON.parse(data.toString()) as (typeof packets)[number]),
  )
  await once(socket, 'open')
  socket.send(JSON.stringify({ type: 'start', token, sdp: 'v=0\r\n' }))
  return { socket, packets }
}

it('использует штатный WebRTC и передаёт реплики без создания отдельных ходов', async () => {
  const { socket, packets } = await open('valid')
  await vi.waitFor(() =>
    expect(packets.some((packet) => packet.type === 'ready')).toBe(true),
  )
  for (const text of ['Первая реплика', 'Уточнение', 'Ещё уточнение']) {
    client.onEvent?.({
      method: 'thread/realtime/item/completed',
      params: { threadId: 'thread', item: { type: 'transcriptSegment', text } },
    })
  }
  socket.send(JSON.stringify({ type: 'stop' }))
  await once(socket, 'close')
  expect(
    calls.filter((call) => call.method === 'thread/realtime/start'),
  ).toEqual([
    {
      method: 'thread/realtime/start',
      params: {
        threadId: 'thread',
        version: 'v3',
        outputModality: 'audio',
        transport: { type: 'webrtc', sdp: 'v=0\r\n' },
        clientManagedHandoffs: false,
        flushTranscriptTailOnSessionEnd: true,
        // initialItems: expect.any(Array),
      },
    },
  ])
  expect(calls.some((call) => call.method === 'turn/start')).toBe(false)
  expect(
    packets.filter(
      (packet) => packet.event?.method === 'thread/realtime/item/completed',
    ),
  ).toHaveLength(4)
  expect(active.size).toBe(0)
  expect(client.close).toHaveBeenCalled()
})

it('не открывает Codex без токена и блокирует параллельный голосовой сеанс', async () => {
  const invalid = await open('invalid')
  await once(invalid.socket, 'close')
  expect(connectCodex).not.toHaveBeenCalled()
  const first = await open('valid')
  await vi.waitFor(() =>
    expect(first.packets.some((packet) => packet.type === 'ready')).toBe(true),
  )
  const second = await open('valid')
  await once(second.socket, 'close')
  expect(second.packets.some((packet) => packet.type === 'error')).toBe(true)
  expect(connectCodex).toHaveBeenCalledTimes(1)
  expect(active.has('session')).toBe(true)
})
