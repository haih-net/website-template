import type * as React from 'react'
import { AIChat } from './AIChat'
import { AiPageStyled } from './styles'

export const AiPage: React.FC = () => (
  <AiPageStyled>
    <h1 tabIndex={-1}>ИИ-помощник</h1>
    <AIChat />
  </AiPageStyled>
)
