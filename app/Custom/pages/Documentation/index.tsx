import type * as React from 'react'
import { Link } from 'react-router'
import { DocumentationStyled } from './styles'

export const DocumentationPage: React.FC = () => (
  <DocumentationStyled>
    <h1 tabIndex={-1}>Документация</h1>
    <p>Устройство сайта, доступные возможности и ограничения.</p>
    <h2>
      <Link to="/docs/transcription">Транскрибация аудио</Link>
    </h2>
    <p>Распознавание файлов: проверка, API, доступ и ограничения.</p>
    <h2>
      <Link to="/docs/video-calls">Видеозвонки</Link>
    </h2>
    <p>
      Групповые P2P-звонки, приглашения по ссылке, защита кодом и демонстрация
      экрана.
    </p>
    <p className="status">
      Базовая реализация, устройство системы и ограничения.
    </p>
  </DocumentationStyled>
)
