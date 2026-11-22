import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { openDictation } from './openDictation'
import type { TranscriptionResult } from './dictationProtocol'

const execute = promisify(execFile)
const sampleRate = 24000
const bytesPerSecond = sampleRate * 2
const maximumSeconds = 240

export interface TranscriptionOptions {
  filePath: string
  language?: string
  signal?: AbortSignal
}

async function decodeAudio(
  filePath: string,
  signal: AbortSignal,
): Promise<Buffer> {
  if (!isAbsolute(filePath)) {
    throw new Error('Укажите абсолютный путь к локальному аудиофайлу')
  }
  const file = await stat(filePath)
  if (!file.isFile() || file.size === 0 || file.size > 25 * 1024 * 1024) {
    throw new Error('Нужен непустой обычный файл размером не более 25 МиБ')
  }
  const { stdout } = await execute(
    'ffmpeg',
    [
      '-nostdin',
      '-v',
      'error',
      '-protocol_whitelist',
      'file,pipe',
      '-i',
      filePath,
      '-map',
      '0:a:0',
      '-t',
      String(maximumSeconds + 1),
      '-ac',
      '1',
      '-ar',
      String(sampleRate),
      '-f',
      's16le',
      'pipe:1',
    ],
    {
      encoding: 'buffer',
      maxBuffer: (maximumSeconds + 2) * bytesPerSecond,
      timeout: 30_000,
      signal,
    },
  )

  if (stdout.length === 0) {
    throw new Error('В файле нет декодируемого аудио')
  }
  if (stdout.length > maximumSeconds * bytesPerSecond) {
    throw new Error(
      'Эксперимент поддерживает записи длительностью до 240 секунд',
    )
  }
  return stdout
}

export async function transcribeAudio(
  options: TranscriptionOptions,
): Promise<TranscriptionResult> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(330000),
    ...(options.signal ? [options.signal] : []),
  ])

  const pcm = await decodeAudio(options.filePath, signal)
  const dictation = await openDictation(
    () => undefined,
    () => undefined,
    options.language ?? 'ru',
  )

  const abort = (): void => dictation.close()
  signal.addEventListener('abort', abort, { once: true })
  try {
    // Темп записи ограничивает буфер сервиса; ускоренную отправку не предполагаем.
    const chunkSize = bytesPerSecond / 10
    for (let offset = 0; offset < pcm.length; offset += chunkSize) {
      signal.throwIfAborted()
      dictation.append(pcm.subarray(offset, offset + chunkSize))
      await delay(100, undefined, { signal })
    }
    const text = await dictation.finish()
    return {
      text,
      segments: dictation.segments(),
      durationSeconds: pcm.length / bytesPerSecond,
      language: options.language ?? 'ru',
      backend: 'codex-desktop-dictation',
      completed: true,
    }
  } finally {
    signal.removeEventListener('abort', abort)
    dictation.close()
  }
}
