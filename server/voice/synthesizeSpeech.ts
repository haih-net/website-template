export async function synthesizeSpeech(
  text: string,
  signal: AbortSignal,
  onChunk: (chunk: Uint8Array) => Promise<void>,
): Promise<void> {
  if (!process.env.CHAT_API_KEY) {
    throw new Error('Не настроен ключ синтеза речи')
  }
  const response = await fetch('https://openrouter.ai/api/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.CHAT_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.SPEECH_MODEL ?? 'qwen/qwen3-tts-1.7b',
      voice: process.env.SPEECH_VOICE ?? 'ryan',
      response_format: 'mp3',
      input: text,
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
  })

  if (
    !response.ok ||
    !response.body ||
    !response.headers.get('content-type')?.includes('audio/')
  ) {
    await response.body?.cancel()
    throw new Error(`Синтез речи недоступен: HTTP ${response.status}`)
  }
  let bytes = 0
  const reader = response.body.getReader()
  try {
    while (true) {
      const { done, value: chunk } = await reader.read()
      if (done) {
        break
      }
      bytes += chunk.length
      if (bytes > 8 * 1024 * 1024) {
        throw new Error('Слишком большой аудиоответ')
      }
      await onChunk(chunk)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
