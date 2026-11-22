interface Portion {
  id: string
  chunks: Uint8Array<ArrayBuffer>[]
  complete: boolean
  size: number
}

/** MSE проигрывает MP3 до окончания HTTP/TTS, с отдельным буфером каждой реплики. */
export class SpeechPlayer {
  private audio = new Audio()
  private portions: Portion[] = []
  private media?: MediaSource
  private source?: SourceBuffer
  private url?: string
  private active = false
  private generation = 0
  private disposed = false
  private pumpHandler = (): void => this.pump()

  constructor(
    private readonly error: (message: string) => void,
    private readonly report: (
      id: string,
      generation: number,
      status: 'playing' | 'ended' | 'interrupted',
      playedMs: number,
    ) => void = () => undefined,
  ) {
    this.audio.onplaying = () => this.reportCurrent('playing')
    this.audio.onended = () => {
      this.reportCurrent('ended')
      this.portions.shift()
      this.clearMedia()
      this.playNext()
    }
    this.audio.onerror = () =>
      this.fail('Не удалось воспроизвести голосовой ответ')
  }

  async unlock(): Promise<void> {
    // Разрешение воспроизведения запрашивается по пользовательскому клику.
    const context = new AudioContext()
    await context.resume()
    const buffer = context.createBuffer(1, 1, 24000)
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(context.destination)
    source.start()
    await context.close()
    if (!window.MediaSource || !MediaSource.isTypeSupported('audio/mpeg')) {
      throw new Error(
        'Браузер не поддерживает потоковое MP3. Текстовый чат остаётся доступен.',
      )
    }
  }

  silence(generation: number): void {
    this.reportCurrent('interrupted')
    this.generation = generation
    this.portions = []
    this.clearMedia()
  }

  start(id: string, generation: number): void {
    if (generation !== this.generation || this.disposed) {
      return
    }
    if (this.portions.length >= 8) {
      this.fail('Слишком большая очередь озвучки')
      return
    }
    this.portions.push({ id, chunks: [], complete: false, size: 0 })
    this.playNext()
  }

  append(id: string, generation: number, base64: string): void {
    if (generation !== this.generation || this.disposed) {
      return
    }
    const portion = this.portions.find((value) => value.id === id)
    if (!portion) {
      return
    }
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
    portion.size += bytes.length
    if (portion.size > 8 * 1024 * 1024) {
      this.fail('Аудиоответ превышает допустимый размер')
      return
    }
    portion.chunks.push(bytes)
    this.pump()
  }

  finish(id: string, generation: number): void {
    if (generation !== this.generation) {
      return
    }
    const portion = this.portions.find((value) => value.id === id)
    if (portion) {
      portion.complete = true
      this.pump()
    }
  }

  private playNext(): void {
    if (this.active || !this.portions.length || this.disposed) {
      return
    }
    this.active = true
    const media = new MediaSource()
    this.media = media
    this.url = URL.createObjectURL(media)
    this.audio.src = this.url
    media.addEventListener(
      'sourceopen',
      () => {
        if (this.media !== media) {
          return
        }
        try {
          this.source = media.addSourceBuffer('audio/mpeg')
          this.source.addEventListener('updateend', this.pumpHandler)
          this.pump()
          void this.audio
            .play()
            .catch(() => this.fail('Разрешите воспроизведение звука для сайта'))
        } catch {
          this.fail('Ошибка потокового проигрывателя')
        }
      },
      { once: true },
    )
  }

  private pump(): void {
    const portion = this.portions[0]
    if (
      !portion ||
      !this.source ||
      this.source.updating ||
      this.media?.readyState !== 'open'
    ) {
      return
    }
    try {
      const chunk = portion.chunks.shift()
      if (chunk) {
        this.source.appendBuffer(chunk)
      } else if (portion.complete) {
        this.media.endOfStream()
      }
    } catch {
      this.fail('Не удалось декодировать поток речи')
    }
  }

  private reportCurrent(status: 'playing' | 'ended' | 'interrupted'): void {
    const portion = this.portions[0]
    if (portion && this.active) {
      this.report(
        portion.id,
        this.generation,
        status,
        Math.max(0, Math.round(this.audio.currentTime * 1000)),
      )
    }
  }

  private clearMedia(): void {
    this.source?.removeEventListener('updateend', this.pumpHandler)
    this.audio.pause()
    this.audio.removeAttribute('src')
    this.audio.load()
    if (this.url) {
      URL.revokeObjectURL(this.url)
    }
    this.source = undefined
    this.media = undefined
    this.url = undefined
    this.active = false
  }

  private fail(message: string): void {
    this.silence(this.generation)
    this.error(message)
  }
  close(): void {
    this.disposed = true
    this.audio.onplaying = null
    this.audio.onended = null
    this.audio.onerror = null
    this.silence(this.generation)
  }
}
