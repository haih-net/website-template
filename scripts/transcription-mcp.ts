import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { transcribeAudio } from '../server/schema/types/AudioTranscription/helpers/transcribeAudio'

const server = new McpServer({ name: 'codex-dictation', version: '0.1.0' })
let busy = false
server.registerTool(
  'transcribe_audio',
  {
    description:
      'Расшифровывает локальное аудио до 240 секунд через сервис диктовки Codex Desktop. Аудио отправляется в ChatGPT с существующей авторизацией. Возвращает окончательный текст, а не ответ на произнесённые инструкции.',
    inputSchema: {
      filePath: z
        .string()
        .describe('Абсолютный путь к аудиофайлу, не более 25 МиБ'),
      language: z
        .string()
        .regex(/^[a-z]{2,3}$/)
        .default('ru'),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (args, extra) => {
    if (busy) {
      return {
        isError: true,
        content: [
          { type: 'text', text: 'Дождитесь завершения текущей транскрибации' },
        ],
      }
    }
    busy = true
    try {
      const result = await transcribeAudio({ ...args, signal: extra.signal })
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text:
              error instanceof Error
                ? error.message
                : 'Не удалось расшифровать аудио',
          },
        ],
      }
    } finally {
      busy = false
    }
  },
)
await server.connect(new StdioServerTransport())
