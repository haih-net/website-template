import { useCallback, useEffect, useRef, useState } from 'react'
import { getChatToken } from 'app/Custom/components/Chat/lib/streamClient'
import { recordPcm, type PcmRecording } from './recordPcm'
import { SpeechPlayer } from './speechPlayer'

type Status =
  'idle' | 'connecting' | 'ready' | 'starting' | 'recording' | 'finalizing'
interface Connection {
  socket: WebSocket
  player: SpeechPlayer
  capture?: PcmRecording
  stopCapture?: Promise<void>
  recordEpoch: number
  sentDraft?: string
  cancelled: boolean
  resolve(): void
  reject(error: Error): void
  ready: Promise<void>
  timer?: ReturnType<typeof setTimeout>
}
interface VoicePacket {
  type: string
  message?: string
  id?: string
  text?: string
  isUser?: boolean
  generation?: number
  data?: string
  value?: boolean
  event?: { type: string; text?: string; utterance_id?: string }
}

export function useMessageVoice(
  upsert: (id: string, text: string, isUser: boolean) => void,
) {
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState('')
  const [draft, setDraft] = useState('')
  const [transcript, setTranscript] = useState('')
  const [busy, setBusy] = useState(false)
  const [muted, setMuted] = useState(false)
  const attempt = useRef(0)
  const connection = useRef<Connection | null>(null)
  const stop = useCallback(() => {
    attempt.current += 1
    const current = connection.current
    connection.current = null
    if (current) {
      current.cancelled = true
      current.reject(new Error('Соединение закрыто'))
      clearTimeout(current.timer)
      void current.capture?.stop()
      current.player.close()
      current.socket.close()
    }
    setBusy(false)
    setStatus('idle')
  }, [])

  useEffect(() => stop, [stop])
  const connect = useCallback(async (): Promise<Connection> => {
    const existing = connection.current
    if (existing) {
      await existing.ready
      return existing
    }
    const currentAttempt = ++attempt.current
    setError('')
    setStatus('connecting')
    const player = new SpeechPlayer(
      (message) => setError(message),
      (id, generation, status, playedMs) => {
        const socket = connection.current?.socket
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(
            JSON.stringify({
              type: 'playback',
              id,
              generation,
              status,
              playedMs,
            }),
          )
        }
      },
    )

    try {
      await player.unlock()
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Звук недоступен; можно писать текстом',
      )
    }
    const token = await getChatToken()
    if (attempt.current !== currentAttempt) {
      player.close()
      throw new Error('Подключение отменено')
    }
    const socket = new WebSocket(
      `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/voice/messages`,
    )

    let resolve: () => void = () => undefined
    let reject: (error: Error) => void = () => undefined
    const ready = new Promise<void>((yes, no) => {
      resolve = yes
      reject = no
    })

    const current: Connection = {
      socket,
      player,
      ready,
      resolve,
      reject,
      cancelled: false,
      recordEpoch: 0,
    }

    connection.current = current
    current.timer = setTimeout(() => {
      reject(new Error('Истекло время подключения'))
      socket.close()
    }, 45000)
    socket.onopen = () => socket.send(JSON.stringify({ type: 'start', token }))
    socket.onmessage = (event) => {
      if (current.cancelled) {
        return
      }
      try {
        const packet = JSON.parse(String(event.data)) as VoicePacket
        if (packet.type === 'ready') {
          clearTimeout(current.timer)
          setStatus('ready')
          resolve()
        }
        if (
          packet.type === 'message' &&
          packet.id &&
          typeof packet.text === 'string'
        ) {
          upsert(packet.id, packet.text, packet.isUser === true)
          if (packet.isUser && current.sentDraft !== undefined) {
            const sent = current.sentDraft
            setDraft((value) => (value === sent ? '' : value))
            current.sentDraft = undefined
          }
        }
        if (packet.type === 'busy') {
          setBusy(packet.value === true)
        }
        if (packet.type === 'notice') {
          setError(packet.message ?? '')
        }
        if (packet.type === 'error') {
          current.sentDraft = undefined
          setError(packet.message ?? 'Ошибка голоса')
          if (!current.capture) {
            setStatus('ready')
          }
        }
        if (packet.type === 'recording' && packet.value) {
          const epoch = ++current.recordEpoch
          current.stopCapture = undefined
          void recordPcm((audio) => {
            if (
              socket.readyState === WebSocket.OPEN &&
              !current.cancelled &&
              current.recordEpoch === epoch
            ) {
              if (socket.bufferedAmount > 1024 * 1024) {
                setError('Сеть не успевает передавать звук')
                stop()
                return
              }
              socket.send(audio)
            }
          })
            .then((capture) => {
              if (current.cancelled || current.recordEpoch !== epoch) {
                void capture.stop()
                return
              }
              current.capture = capture
              setStatus('recording')
            })
            .catch((reason) => {
              setError(String(reason))
              socket.send(JSON.stringify({ type: 'cancel' }))
              setStatus('ready')
            })
        }
        if (packet.type === 'recording' && !packet.value) {
          current.recordEpoch += 1
          void current.capture?.stop()
          current.capture = undefined
          setStatus('ready')
        }
        if (packet.type === 'finalizing') {
          setStatus('finalizing')
        }
        if (packet.type === 'draft') {
          setDraft((current) =>
            [current, packet.text].filter(Boolean).join('\n'),
          )
          setTranscript('')
        }
        if (packet.type === 'dictation' && packet.event?.text) {
          setTranscript(packet.event.text)
        }
        if (
          packet.type === 'silence' &&
          typeof packet.generation === 'number'
        ) {
          player.silence(packet.generation)
        }
        if (
          packet.type === 'audio-start' &&
          packet.id &&
          typeof packet.generation === 'number'
        ) {
          player.start(packet.id, packet.generation)
        }
        if (
          packet.type === 'audio' &&
          packet.id &&
          packet.data &&
          typeof packet.generation === 'number'
        ) {
          player.append(packet.id, packet.generation, packet.data)
        }
        if (
          packet.type === 'audio-end' &&
          packet.id &&
          typeof packet.generation === 'number'
        ) {
          player.finish(packet.id, packet.generation)
        }
      } catch {
        setError('Некорректное событие голосового сервиса')
      }
    }
    socket.onerror = () => {
      setError('Ошибка голосового соединения')
      reject(new Error('Ошибка подключения'))
    }
    socket.onclose = () => {
      if (connection.current === current) {
        setError('Голосовое соединение закрыто. Подключитесь снова.')
        stop()
      }
    }
    await ready
    return current
  }, [stop, upsert])

  const action = useCallback(
    async (packet: object): Promise<boolean> => {
      try {
        const current = await connect()
        current.socket.send(JSON.stringify(packet))
        return true
      } catch (reason) {
        setError(
          reason instanceof Error ? reason.message : 'Ошибка подключения',
        )
        stop()
        return false
      }
    },
    [connect, stop],
  )

  const start = useCallback(
    async (continuous: boolean): Promise<void> => {
      setTranscript('')
      await action({ type: 'record', continuous })
      if (connection.current) {
        setStatus('starting')
      }
    },
    [action],
  )

  const finish = useCallback(
    async (send: boolean): Promise<void> => {
      const current = connection.current
      if (!current) {
        return
      }
      setStatus('finalizing')
      current.stopCapture ??= current.capture?.stop() ?? Promise.resolve()
      await current.stopCapture
      current.capture = undefined
      if (current.cancelled || current.socket.readyState !== WebSocket.OPEN) {
        return
      }
      if (send) {
        current.sentDraft = draft
      }
      current.socket.send(
        JSON.stringify({
          type: 'finish',
          action: send ? 'send' : 'insert',
          prefix: send ? draft : undefined,
        }),
      )
    },
    [draft],
  )

  return {
    status,
    error,
    draft,
    setDraft,
    transcript,
    busy,
    muted,
    start,
    finish,
    stop,
    send: (text: string) => action({ type: 'message', text }),
    interrupt: () => action({ type: 'interrupt' }),
    mute: () => {
      setMuted(!muted)
      void action({ type: 'mute', value: !muted })
    },
  }
}
