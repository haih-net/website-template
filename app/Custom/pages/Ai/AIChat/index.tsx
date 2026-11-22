import type * as React from 'react'
import { useCallback, useState, useEffect } from 'react'
import { MessageVoice } from './MessageVoice'
import { Mic, Square } from 'lucide-react'
import { ChatContent } from 'app/Custom/components/Chat/ChatWidget/ChatContent'
import { useChatContext } from 'app/Custom/components/Chat/ChatWidget/context'
import { isCodexChat } from 'app/Custom/components/Chat/lib/streamClient'
import { useVoiceChat } from './useVoiceChat'
import { AIChatStyled, VoiceButton } from './styles'

export const AIChat: React.FC = () => {
  const [mode, setMode] = useState<'off' | 'realtime' | 'messages'>('off')
  useEffect(() => {
    const controller = new AbortController()
    void fetch('/api/voice/config', { signal: controller.signal })
      .then((response) => response.json())
      .then((config: { mode?: string }) => {
        if (config.mode === 'messages' || config.mode === 'realtime') {
          setMode(config.mode)
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          console.error('Не удалось получить настройки голоса', error)
        }
      })
    return () => controller.abort()
  }, [])
  const { upsertVoiceMessage, isLoading } = useChatContext()
  const { status, error, start, stop } = useVoiceChat(upsertVoiceMessage)
  const active = status !== 'idle'
  const toggleVoice = useCallback((): void => {
    if (active) {
      stop()
    } else {
      void start('maple')
    }
  }, [active, stop, start])

  if (mode === 'messages' && isCodexChat) {
    return (
      <AIChatStyled>
        <MessageVoice />
      </AIChatStyled>
    )
  }

  return (
    <AIChatStyled>
      <ChatContent
        controls={
          isCodexChat &&
          mode === 'realtime' && (
            <VoiceButton
              type="button"
              aria-label={active ? 'Завершить разговор' : 'Голосовой режим'}
              title={
                error || (active ? 'Завершить разговор' : 'Голосовой режим')
              }
              aria-pressed={active}
              disabled={isLoading || status === 'stopping'}
              onClick={toggleVoice}
            >
              {active ? (
                <Square size={20} aria-hidden="true" />
              ) : (
                <Mic size={20} aria-hidden="true" />
              )}
            </VoiceButton>
          )
        }
      />
    </AIChatStyled>
  )
}
