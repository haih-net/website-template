import type { CodexConnection } from './connectCodex'

export interface HistoryMessage {
  id: string
  text: string
  isUser: boolean
}

export async function threadHistory(
  client: CodexConnection,
  threadId: string,
): Promise<HistoryMessage[]> {
  const result = await client.request<{
    thread: {
      turns?: {
        items?: {
          id: string
          type: string
          text?: string
          content?: { type: string; text?: string }[]
        }[]
      }[]
    }
  }>('thread/read', { threadId, includeTurns: true })

  return (result.thread.turns ?? []).flatMap((turn) =>
    (turn.items ?? []).flatMap<HistoryMessage>((item) => {
      if (item.type === 'agentMessage' && item.text) {
        return [{ id: item.id, text: item.text, isUser: false }]
      }
      if (item.type === 'userMessage') {
        const text = (item.content ?? [])
          .filter((value) => value.type === 'text')
          .map((value) => value.text ?? '')
          .join('\n')

        return text ? [{ id: item.id, text, isUser: true }] : []
      }
      return []
    }),
  )
}
