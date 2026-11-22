import type * as React from 'react'
import { useCallback } from 'react'
import { Mic, Square, LoaderCircle } from 'lucide-react'
import { VoiceButton } from './styles'
import { ChatContent } from 'app/Custom/components/Chat/ChatWidget/ChatContent'
import { useChatContext } from 'app/Custom/components/Chat/ChatWidget/context'
import {
  ChatForm,
  ChatTextarea,
  SendButton,
} from 'app/Custom/components/Chat/ChatWidget/styles'
import { useMessageVoice } from './useMessageVoice'

export const MessageVoice: React.FC = () => {
  const { upsertVoiceMessage } = useChatContext()
  const voice = useMessageVoice(upsertVoiceMessage)
  const recording = voice.status === 'recording'
  const finishing = voice.status === 'finalizing'
  const stopAnswer =
    voice.busy && !voice.draft.trim() && !recording && !finishing
  const starting = voice.status === 'starting' || voice.status === 'connecting'
  const toggleRecord = useCallback((): void => {
    if (starting) {
      voice.stop()
    } else if (recording) {
      void voice.finish(false)
    } else {
      void voice.start(false)
    }
  }, [starting, recording, voice])

  const onSubmit = useCallback(
    (event: React.SubmitEvent): void => {
      event.preventDefault()
      if (stopAnswer) {
        void voice.interrupt()
        return
      }
      if (recording || finishing) {
        void voice.finish(true)
        return
      }
      if (voice.draft.trim()) {
        const text = voice.draft
        void voice.send(text).then((sent) => {
          if (sent) {
            voice.setDraft((current) => (current === text ? '' : current))
          }
        })
      }
    },
    [stopAnswer, recording, finishing, voice],
  )

  const onChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>): void =>
      voice.setDraft(event.target.value),
    [voice],
  )

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
      if (
        event.key === 'Enter' &&
        !event.shiftKey &&
        !event.nativeEvent.isComposing
      ) {
        event.preventDefault()
        event.currentTarget.form?.requestSubmit()
      }
    },
    [],
  )

  return (
    <ChatContent
      input={
        <>
          <ChatForm onSubmit={onSubmit}>
            <ChatTextarea
              aria-label="Сообщение помощнику"
              placeholder={
                recording
                  ? voice.transcript || 'Говорите…'
                  : finishing
                    ? 'Распознаём…'
                    : 'Напишите сообщение…'
              }
              rows={1}
              value={voice.draft}
              onChange={onChange}
              disabled={recording || finishing || starting}
              onKeyDown={onKeyDown}
            />
            <VoiceButton
              type="button"
              aria-label={
                starting
                  ? 'Отменить подключение'
                  : recording
                    ? 'Остановить запись'
                    : 'Записать голос'
              }
              title={
                starting
                  ? 'Отменить подключение'
                  : recording
                    ? 'Остановить запись'
                    : 'Записать голос'
              }
              aria-pressed={recording}
              disabled={finishing}
              onClick={toggleRecord}
            >
              {starting || finishing ? (
                <LoaderCircle size={20} aria-hidden="true" />
              ) : recording ? (
                <Square size={20} aria-hidden="true" />
              ) : (
                <Mic size={20} aria-hidden="true" />
              )}
            </VoiceButton>
            <SendButton
              type="submit"
              aria-label={
                stopAnswer ? 'Остановить ответ' : 'Отправить сообщение'
              }
              data-has-text={recording || finishing || !!voice.draft.trim()}
              disabled={
                starting ||
                (!stopAnswer && !recording && !finishing && !voice.draft.trim())
              }
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                {stopAnswer ? (
                  <rect x="6" y="6" width="12" height="12" rx="2" />
                ) : (
                  <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                )}
              </svg>
            </SendButton>
          </ChatForm>
          {voice.error && (
            <p className="voice-error" role="alert">
              {voice.error}
            </p>
          )}
        </>
      }
    />
  )
}
