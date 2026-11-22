import { parseArgs } from 'node:util'
import { transcribeAudio } from '../server/schema/types/AudioTranscription/helpers/transcribeAudio'

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      language: { type: 'string', default: 'ru' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean' },
    },
  })

  if (values.help) {
    process.stdout.write(
      'Использование: npm run transcribe:audio -- /абсолютный/путь/голос.ogg [--language ru] [--json]\n',
    )
  } else {
    if (positionals.length !== 1) {
      throw new Error(
        'Укажите один абсолютный путь к аудиофайлу; справка: --help',
      )
    }
    const controller = new AbortController()
    process.once('SIGINT', () => controller.abort())
    process.once('SIGTERM', () => controller.abort())
    const result = await transcribeAudio({
      filePath: positionals[0],
      language: values.language,
      signal: controller.signal,
    })

    process.stdout.write(
      (values.json ? JSON.stringify(result, null, 2) : result.text) + '\n',
    )
  }
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message
      : 'Не удалось выполнить транскрибацию',
  )
  process.exitCode = 1
}
