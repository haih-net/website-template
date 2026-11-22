import { randomUUID } from 'node:crypto'
import {
  connectCodex,
  type CodexConnection,
  type CodexEvent,
} from '../codex/helpers/connectCodex'
import {
  readSessionThread,
  saveSessionThread,
} from '../codex/helpers/sessionThread'
import { SpeechChunks } from './speechChunks'

import { voiceInstructions, voiceTools } from './instructions'

export interface AgentVoiceOutput {
  send(event: object): void
  speak(text: string, generation: number): void
  generation(): number
  speakingEnabled(): boolean
  playbackContext?(): string
  disconnect?(): void
}

export class VoiceAgent {
  private client?: CodexConnection
  private threadId?: string
  private turnId?: string
  private starting = false
  private closed = false
  private armed = false
  private interruptedSpeech = false
  private speechItem?: string
  private speech?: SpeechChunks
  private turnGeneration = 0
  private pendingInput?: { text: string; generation: number }
  private queue: Promise<void> = Promise.resolve()
  private items = new Map<string, string>()

  constructor(
    private readonly sessionId: string,
    private readonly output: AgentVoiceOutput,
  ) {}

  async connect(): Promise<void> {
    this.client = await connectCodex(() => this.threadId)
    this.client.onToolCall = async (params) => {
      const allowed =
        params.tool === 'speak' &&
        params.turnId === this.turnId &&
        this.output.speakingEnabled() &&
        this.turnGeneration === this.output.generation()

      this.armed = allowed
      return {
        success: allowed,
        contentItems: [
          {
            type: 'inputText',
            text: allowed
              ? 'Следующее сообщение будет озвучено порциями по разделителю ---. Пиши только устную речь. Это разрешение на синтез, не подтверждение прослушивания.'
              : 'Озвучка недоступна или этот ответ перебит. Продолжай текстом.',
          },
        ],
      }
    }
    this.client.onEvent = (event) => this.event(event)
    this.client.onClose = (error) => {
      if (!this.closed) {
        this.output.send({ type: 'error', message: error.message })
        this.output.disconnect?.()
      }
    }
    this.threadId = (await readSessionThread(this.sessionId)) ?? undefined
    if (this.threadId) {
      await this.client.request('thread/resume', {
        threadId: this.threadId,
        excludeTurns: true,
        developerInstructions: voiceInstructions,
      })
      // Dynamic tools могут отсутствовать в старом thread. Не создаём новый контекст скрытно.
      this.output.send({
        type: 'notice',
        message:
          'Продолжаем существующий диалог. Доступность озвучки зависит от инструментов этого диалога.',
      })
    } else {
      const result = await this.client.request<{ thread: { id: string } }>(
        'thread/start',
        {
          cwd: '/codex/workspace',
          approvalPolicy: 'never',
          sandbox: 'read-only',
          ephemeral: false,
          developerInstructions: voiceInstructions,
          baseInstructions: '',
          dynamicTools: voiceTools,
        },
      )

      this.threadId = result.thread.id
      await saveSessionThread(this.sessionId, this.threadId)
    }
  }

  submit(text: string): Promise<void> {
    const job = this.queue.then(async () => {
      if (this.closed || !this.client || !this.threadId) {
        throw new Error('Голосовой чат закрыт')
      }
      if (!text.trim() || text.length > 16000) {
        throw new Error('Некорректная длина сообщения')
      }
      const id = randomUUID()
      this.output.send({ type: 'message', id, text, isUser: true })
      this.armed = false
      this.speech?.cancel()
      this.speech = undefined
      this.speechItem = undefined
      this.turnGeneration = -1
      this.pendingInput = { text, generation: this.output.generation() }
      if (this.turnId) {
        const expectedTurnId = this.turnId
        try {
          await this.client.request('turn/steer', {
            threadId: this.threadId,
            expectedTurnId,
            input: [{ type: 'text', text }],
            additionalContext: this.additionalContext(),
          })
          this.output.send({ type: 'busy', value: true })
          return
        } catch (error) {
          // Повторно начинаем ход только после подтверждённого завершения прежнего.
          if (this.turnId === expectedTurnId) {
            throw error
          }
        }
      }
      this.starting = true
      this.output.send({ type: 'busy', value: true })
      try {
        const result = await this.client.request<{ turn: { id: string } }>(
          'turn/start',
          {
            threadId: this.threadId,
            input: [{ type: 'text', text }],
            additionalContext: this.additionalContext(),
          },
        )

        if (this.starting) {
          this.turnId = result.turn.id
        }
      } finally {
        this.starting = false
      }
    })

    this.queue = job.catch(() => undefined)
    return job
  }

  private additionalContext(): object {
    return {
      voice_playback: {
        kind: 'application',
        value:
          'Старое аудио остановлено новым вводом. Если ты уже начал речевое сообщение, его новая версия продолжает озвучиваться; сохраняй формат устной речи. ' +
          (this.output.playbackContext?.() ??
            'Нет подтверждения воспроизведения. Не считай сгенерированное аудио услышанным.'),
      },
    }
  }

  silence(preserveSpeech = true): void {
    this.interruptedSpeech =
      preserveSpeech &&
      (this.interruptedSpeech || this.armed || Boolean(this.speechItem))
    this.armed = false
    this.speech?.cancel()
    this.speech = undefined
    this.speechItem = undefined
  }

  async interrupt(): Promise<void> {
    this.silence()
    if (this.turnId) {
      await this.client?.request('turn/interrupt', {
        threadId: this.threadId,
        turnId: this.turnId,
      })
    }
  }

  private event(event: CodexEvent): void {
    if (event.params.threadId !== this.threadId || this.closed) {
      return
    }
    const { params } = event
    if (event.method === 'turn/started' && params.turn) {
      this.turnId = params.turn.id
    }
    const item = params.item as
      | {
          id?: string
          type?: string
          text?: string
          content?: { type: string; text?: string }[]
        }
      | undefined

    if (
      event.method === 'item/started' &&
      item?.type === 'userMessage' &&
      this.pendingInput
    ) {
      const text = (item.content ?? [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join('\n')

      if (text === this.pendingInput.text) {
        this.turnGeneration = this.pendingInput.generation
        this.pendingInput = undefined
        this.armed =
          this.interruptedSpeech &&
          this.turnGeneration === this.output.generation()
        this.interruptedSpeech = false
      }
    }
    if (
      event.method === 'item/started' &&
      item?.type === 'agentMessage' &&
      item.id
    ) {
      if (this.items.size > 200) {
        this.items.clear()
      }
      this.items.set(item.id, '')
      if (this.armed && this.turnGeneration === this.output.generation()) {
        this.armed = false
        this.speechItem = item.id
        const generation = this.turnGeneration
        this.speech = new SpeechChunks((text) =>
          this.output.speak(text, generation),
        )
      }
    }
    if (
      event.method === 'item/agentMessage/delta' &&
      typeof params.itemId === 'string' &&
      typeof params.delta === 'string'
    ) {
      const text = (this.items.get(params.itemId) ?? '') + params.delta
      this.items.set(params.itemId, text)
      this.output.send({
        type: 'message',
        id: params.itemId,
        text,
        isUser: false,
      })
      if (params.itemId === this.speechItem) {
        try {
          this.speech?.append(params.delta)
        } catch (error) {
          this.silence()
          this.output.send({
            type: 'error',
            message:
              error instanceof Error ? error.message : 'Ошибка речевого текста',
          })
        }
      }
    }
    if (event.method === 'item/completed' && item?.id === this.speechItem) {
      this.speech?.finish()
      this.speech = undefined
      this.speechItem = undefined
    }
    if (event.method === 'turn/completed') {
      this.starting = false
      this.turnId = undefined
      this.silence(false)
      this.output.send({ type: 'busy', value: false })
      if (params.turn?.status !== 'completed') {
        this.output.send({
          type: 'notice',
          message: params.turn?.error?.message ?? 'Ответ остановлен',
        })
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true
    try {
      await this.interrupt()
    } finally {
      this.client?.close()
    }
  }
}
