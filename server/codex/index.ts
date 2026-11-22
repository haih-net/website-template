import { voiceTools } from '../voice/instructions'
import { threadHistory } from './helpers/threadHistory'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { readSessionThread, saveSessionThread } from './helpers/sessionThread'
import express, { type Express } from 'express'
import { connectCodex, type CodexConnection } from './helpers/connectCodex'
import { issueSessionToken, verifySessionToken } from './helpers/sessionToken'
import { createChatResponse } from '../chat/http/response'
import { logDevError } from '../errorLogging'

export const activeCodexSessions: Set<string> = new Set()

export function setupCodexChat(app: Express): void {
  const active = activeCodexSessions
  const router = express.Router()
  router.use(express.json({ limit: '256kb' }))
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-transform')
    next()
  })
  router.get('/', async (req, res) => {
    const sessionId = verifySessionToken(req.get('dialog-token'))
    if (!sessionId) {
      res.status(401).json({ error: 'Недействительный токен чата' })
      return
    }
    let client: CodexConnection | undefined
    try {
      const threadId = await readSessionThread(sessionId)
      if (!threadId) {
        res.json({ messages: [] })
        return
      }
      client = await connectCodex(() => threadId)
      res.json({ messages: await threadHistory(client, threadId) })
    } catch (error) {
      logDevError('codex.history', error)
      res.status(502).json({ error: 'Не удалось загрузить историю' })
    } finally {
      client?.close()
    }
  })
  router.post('/token', (_req, res) => {
    try {
      res.json({ token: issueSessionToken(randomUUID()) })
    } catch (error) {
      logDevError('codex.token', error)
      res.status(502).json({ error: 'Не удалось создать сессию Codex' })
    }
  })
  router.post('/', async (req, res) => {
    const sessionId = verifySessionToken(req.get('dialog-token'))
    if (!sessionId) {
      res.status(401).json({
        code: 'INVALID_DIALOG_TOKEN',
        error: 'Недействительный токен чата',
      })
      return
    }
    if (
      typeof req.body?.message !== 'string' ||
      !req.body.message.trim() ||
      req.body.message.length > 16000 ||
      (req.body.stream !== undefined && typeof req.body.stream !== 'boolean')
    ) {
      res.status(400).json({ error: 'Некорректное сообщение' })
      return
    }
    if (active.has(sessionId)) {
      res.status(409).json({ error: 'Дождитесь завершения предыдущего ответа' })
      return
    }
    active.add(sessionId)
    const controller = new AbortController()
    const disconnect = (): void => controller.abort(new Error('Запрос прерван'))
    const timeout = setTimeout(disconnect, 120000)
    res.on('close', disconnect)
    const delivery = createChatResponse(
      res,
      req.body.stream ?? true,
      controller.signal,
    )

    let client: CodexConnection | undefined
    let threadId: string | undefined
    let turnId: string | undefined
    let completed = false
    try {
      client = await connectCodex(() => threadId)
      client.onToolCall = async () => ({
        success: false,
        contentItems: [
          {
            type: 'inputText',
            text: 'В текущем текстовом интерфейсе голосовые инструменты отключены. Продолжай отвечать текстом.',
          },
        ],
      })
      controller.signal.throwIfAborted()
      threadId = (await readSessionThread(sessionId)) ?? undefined
      if (threadId) {
        await client.request('thread/resume', { threadId, excludeTurns: true })
      } else {
        const result = await client.request<{ thread: { id: string } }>(
          'thread/start',
          {
            cwd: '/codex/workspace',
            approvalPolicy: 'never',
            sandbox: 'read-only',
            baseInstructions: '',
            developerInstructions: '',
            dynamicTools: voiceTools,
            ephemeral: false,
          },
        )

        threadId = result.thread.id
      }
      let content = ''
      let writes = Promise.resolve()
      let finish: (id: string) => void = () => undefined
      let fail: (error: Error) => void = () => undefined
      const done = new Promise<string>((resolve, reject) => {
        finish = resolve
        fail = reject
      })

      // Обработчик нужен до turn/start: соединение может оборваться раньше ответа.
      void done.catch(() => undefined)
      const abort = (): void => fail(new Error('Запрос прерван'))
      controller.signal.addEventListener('abort', abort, { once: true })
      client.onClose = fail
      client.onEvent = (event) => {
        if (event.params.threadId !== threadId) {
          return
        }
        if (
          event.method === 'item/agentMessage/delta' &&
          typeof event.params.delta === 'string'
        ) {
          const delta = event.params.delta
          content += delta
          writes = writes.then(() =>
            delivery.event(
              { type: 'content', content: delta },
              controller.signal,
            ),
          )
          void writes.catch(fail)
        }
        if (
          event.method !== 'item/agentMessage/delta' &&
          (event.method.startsWith('item/') ||
            event.method.startsWith('turn/') ||
            event.method.startsWith('thread/') ||
            event.method === 'error')
        ) {
          writes = writes.then(async () => {
            controller.signal.throwIfAborted()
            if (req.body.stream === false) {
              return
            }
            if (
              !res.write(`data: ${JSON.stringify({ codexEvent: event })}\n\n`)
            ) {
              await once(res, 'drain', { signal: controller.signal })
            }
          })
          void writes.catch(fail)
        }
        if (event.method === 'turn/completed' && event.params.turn) {
          completed = true
          if (event.params.turn.status === 'completed') {
            finish(event.params.turn.id)
          } else {
            fail(
              new Error(
                event.params.turn.error?.message || 'Codex не завершил ответ',
              ),
            )
          }
        }
      }
      await delivery.event({ type: 'ready' }, controller.signal)
      const turn = await client.request<{ turn: { id: string } }>(
        'turn/start',
        {
          threadId,
          input: [{ type: 'text', text: req.body.message }],
        },
      )

      turnId = turn.turn.id
      await saveSessionThread(sessionId, threadId)
      controller.signal.throwIfAborted()
      const id = await done
      await writes
      controller.signal.removeEventListener('abort', abort)
      await delivery.finish({ id, success: true, content, usage: {} })
    } catch (error) {
      logDevError('codex.message', error, { threadId })
      delivery.fail(error)
    } finally {
      if (client && turnId && !completed) {
        await client
          .request('turn/interrupt', { threadId, turnId })
          .catch((error: unknown) =>
            logDevError('codex.interrupt', error, { threadId }),
          )
      }
      if (client && threadId) {
        await client
          .request('thread/unsubscribe', { threadId })
          .catch((error: unknown) =>
            logDevError('codex.unsubscribe', error, { threadId }),
          )
      }
      client?.close()
      clearTimeout(timeout)
      res.off('close', disconnect)
      active.delete(sessionId)
    }
  })
  app.use('/api/codex', router)
}
