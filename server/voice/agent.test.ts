import { afterEach, expect, it, vi } from 'vitest'
import { VoiceAgent } from './agent'
import type { CodexConnection, CodexEvent } from '../codex/helpers/connectCodex'

const state = vi.hoisted(() => ({
  client: undefined as CodexConnection | undefined,
}))

vi.mock('../codex/helpers/connectCodex', () => ({
  connectCodex: async () => state.client,
}))
vi.mock('../codex/helpers/sessionThread', () => ({
  readSessionThread: async () => null,
  saveSessionThread: async () => undefined,
}))
afterEach(() => vi.restoreAllMocks())

it('озвучивает завершённые порции и отклоняет старое разрешение после перебивания до принятия нового ввода', async () => {
  const request = vi.fn(async (method: string) =>
    method === 'thread/start'
      ? { thread: { id: 'thread' } }
      : { turn: { id: 'turn' } },
  )

  const client = { request, close: vi.fn() } as unknown as CodexConnection
  state.client = client
  let generation = 0
  const speak = vi.fn()
  const agent = new VoiceAgent('session', {
    send: vi.fn(),
    speak,
    generation: () => generation,
    speakingEnabled: () => true,
  })

  const event = (method: string, params: CodexEvent['params']): void =>
    client.onEvent?.({ method, params: { threadId: 'thread', ...params } })

  const accepted = (text: string): void =>
    event('item/started', {
      item: { type: 'userMessage', content: [{ type: 'text', text }] },
    })

  try {
    await agent.connect()
    await agent.submit('Первый вопрос')
    accepted('Первый вопрос')
    expect(
      (await client.onToolCall?.({ tool: 'speak', turnId: 'turn' }))?.success,
    ).toBe(true)
    event('item/started', { item: { type: 'agentMessage', id: 'a' } })
    event('item/agentMessage/delta', {
      itemId: 'a',
      delta: 'Первая порция.\n\n---\nХвост',
    })
    expect(speak).toHaveBeenCalledWith('Первая порция.', 0)
    generation++
    agent.silence()
    await agent.submit('Уточнение')
    expect(request).toHaveBeenCalledWith(
      'turn/steer',
      expect.objectContaining({ expectedTurnId: 'turn' }),
    )
    expect(
      (await client.onToolCall?.({ tool: 'speak', turnId: 'turn' }))?.success,
    ).toBe(false)
    event('item/agentMessage/delta', {
      itemId: 'a',
      delta: ' устарел\n\n---\n',
    })
    accepted('Уточнение')
    // Продолжение перебитого речевого сообщения сохраняет намерение озвучки.
    event('item/started', { item: { type: 'agentMessage', id: 'b' } })
    event('item/agentMessage/delta', {
      itemId: 'b',
      delta: 'Исправленная реплика.',
    })
    event('item/completed', { item: { id: 'b' } })
    expect(speak.mock.calls).toEqual([
      ['Первая порция.', 0],
      ['Исправленная реплика.', 1],
    ])
  } finally {
    await agent.close()
  }
})
