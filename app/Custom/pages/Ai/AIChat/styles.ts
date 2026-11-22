import { styled } from '@linaria/react'
import { ChatContentContainer } from 'app/Custom/components/Chat/ChatWidget/styles'

export const AIChatStyled = styled.div`
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  min-width: 0;
  width: 100%;
  ${ChatContentContainer} {
    max-width: 900px;
  }
  .voice-error {
    color: #a12c2c;
    margin: 0;
    width: 100%;
    text-align: center;
    overflow-wrap: anywhere;
  }
`

export const VoiceButton = styled.button`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  flex-shrink: 0;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: #475569;
  cursor: pointer;
  &:hover {
    background: #f1f5f9;
  }
  &[aria-pressed='true'] {
    color: #b91c1c;
    background: #fee2e2;
  }
  &:disabled {
    opacity: 0.5;
    cursor: default;
  }
  &:focus-visible {
    outline: 2px solid #475569;
    outline-offset: 2px;
  }
`
