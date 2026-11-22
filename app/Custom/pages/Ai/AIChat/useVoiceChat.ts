import type { CodexVoice } from 'app/Custom/components/Chat/lib/codexVoices'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getChatToken,
  CHAT_TOKEN_STORAGE_KEY,
} from 'app/Custom/components/Chat/lib/streamClient'
import { captureAudio, type VoiceCapture } from './captureAudio'

export type VoiceStatus =
  'idle' | 'connecting' | 'listening' | 'reconnecting' | 'stopping'
interface VoiceSession {
  capture?: VoiceCapture
  socket?: WebSocket
  cancelled: boolean
  stopping?: boolean
  timer?: ReturnType<typeof setTimeout>
}

interface VoiceEvent {
  method: string
  params: {
    item?: { id: string; type: string; role?: string; text?: string }
    itemId?: string
    delta?: string
    sdp?: string
  }
}

export function useVoiceChat(
  upsert: (id: string, text: string, isUser: boolean) => void,
): {
  status: VoiceStatus
  error: string
  start: (voice: CodexVoice) => Promise<void>
  stop: () => void
} {
  const [status, setStatus] = useState<VoiceStatus>('idle')
  const [error, setError] = useState('')
  const session = useRef<VoiceSession | null>(null)
  const release = useCallback((): void => {
    const current = session.current
    if (!current) {
      return
    }
    current.cancelled = true
    clearTimeout(current.timer)
    current.capture?.stop()
    current.socket?.close()
    session.current = null
  }, [])

  useEffect(() => release, [release])
  const stop = useCallback((): void => {
    const current = session.current
    if (!current) {
      return
    }
    current.stopping = true
    setStatus('stopping')
    current.capture?.mute()
    if (current.socket?.readyState === WebSocket.OPEN) {
      current.socket.send(JSON.stringify({ type: 'stop' }))
      clearTimeout(current.timer)
      current.timer = setTimeout(() => {
        release()
        setStatus('idle')
      }, 10000)
    } else {
      release()
      setStatus('idle')
    }
  }, [release])

  const start = useCallback(
    async (voice: CodexVoice): Promise<void> => {
      if (session.current) {
        return
      }
      const current: VoiceSession = { cancelled: false }
      session.current = current
      setStatus('connecting')
      setError('')
      const fail = (message: string): void => {
        if (session.current !== current) {
          return
        }
        setError(message)
        release()
        setStatus('idle')
      }

      let serverReady = false
      let audioReady = false
      let wasListening = false
      const updateReadiness = (): void => {
        if (session.current !== current || current.stopping) {
          return
        }
        const ready =
          serverReady &&
          audioReady &&
          current.socket?.readyState === WebSocket.OPEN

        current.capture?.setListening(ready)
        if (ready) {
          clearTimeout(current.timer)
          wasListening = true
          setStatus('listening')
        } else {
          setStatus(wasListening ? 'reconnecting' : 'connecting')
          if (wasListening) {
            clearTimeout(current.timer)
            current.timer = setTimeout(
              () =>
                fail(
                  'Не удалось восстановить голосовое соединение. Включите голосовой режим снова.',
                ),
              10000,
            )
          }
        }
      }

      const items = new Map<string, { text: string; isUser: boolean }>()
      try {
        current.capture = await captureAudio((connected) => {
          audioReady = connected
          updateReadiness()
        }, fail)
        if (current.cancelled || current.stopping) {
          current.capture.stop()
          return
        }
        current.timer = setTimeout(
          () => fail('Не удалось дождаться подключения голосового режима.'),
          50000,
        )
        const token = await getChatToken()
        if (current.cancelled || current.stopping) {
          return
        }
        const url = new URL('/api/codex/voice', window.location.href)
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
        const socket = new WebSocket(url)
        current.socket = socket
        socket.onopen = () => {
          if (session.current !== current || current.stopping) {
            return
          }
          socket.send(
            JSON.stringify({
              type: 'start',
              token,
              sdp: current.capture?.sdp,
              voice,
            }),
          )
        }
        socket.onerror = () =>
          fail('Не удалось подключиться к голосовому сервису.')
        socket.onclose = (event) => {
          if (session.current !== current) {
            return
          }
          if (!current.stopping || event.code !== 1000) {
            setError(
              (previous) =>
                previous ||
                'Голосовое соединение прервано. Попробуйте включить его снова.',
            )
          }
          release()
          setStatus('idle')
        }
        socket.onmessage = (message: MessageEvent<string>) => {
          if (current.cancelled) {
            return
          }
          let packet: {
            type: string
            message?: string
            code?: string
            event?: VoiceEvent
          }

          try {
            packet = JSON.parse(message.data) as typeof packet
          } catch {
            fail('Некорректный ответ голосового сервиса.')
            return
          }
          if (packet.type === 'error') {
            if (packet.code === 'INVALID_DIALOG_TOKEN') {
              localStorage.removeItem(CHAT_TOKEN_STORAGE_KEY)
            }
            fail(packet.message || 'Голосовой режим недоступен.')
            return
          }
          if (packet.type === 'ready') {
            serverReady = true
            updateReadiness()
            return
          }
          const event = packet.event
          if (!event) {
            return
          }
          if (
            event.method === 'thread/realtime/sdp' &&
            event.params.sdp &&
            !current.stopping
          ) {
            void current.capture
              ?.acceptAnswer(event.params.sdp)
              .catch(() => fail('Не удалось согласовать аудиосоединение.'))
          }
          const item = event.params.item
          if (
            (event.method === 'thread/realtime/item/started' ||
              event.method === 'thread/realtime/item/completed') &&
            item?.type === 'transcriptSegment'
          ) {
            const value = {
              text: item.text ?? '',
              isUser: item.role === 'user',
            }

            items.set(item.id, value)
            if (value.text) {
              upsert(`voice_${item.id}`, value.text, value.isUser)
            }
          }
          if (
            event.method === 'thread/realtime/item/transcript/delta' &&
            event.params.itemId
          ) {
            const value = items.get(event.params.itemId)
            if (value) {
              value.text += event.params.delta ?? ''
              upsert(`voice_${event.params.itemId}`, value.text, value.isUser)
            }
          }
        }
      } catch (cause) {
        if (cause instanceof DOMException) {
          fail(
            cause.name === 'NotAllowedError'
              ? 'Разрешите доступ к микрофону в настройках браузера.'
              : cause.name === 'NotFoundError'
                ? 'Микрофон не найден. Подключите его и попробуйте снова.'
                : 'Не удалось открыть микрофон. Проверьте, не занят ли он другим приложением.',
          )
        } else {
          fail(
            cause instanceof Error
              ? cause.message
              : 'Не удалось включить микрофон.',
          )
        }
      }
    },
    [release, upsert],
  )

  return { status, error, start, stop }
}
