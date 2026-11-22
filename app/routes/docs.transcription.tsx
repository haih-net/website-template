import type { MetaFunction } from 'react-router'
import { createSeoMeta, unavailableSeoMeta } from '../components/seo/SeoHeaders'
import { TranscriptionDocumentationPage } from 'app/Custom/pages/Documentation/Transcription'

export const meta: MetaFunction = ({ error }) =>
  error
    ? unavailableSeoMeta()
    : createSeoMeta({
        title: 'Транскрибация аудио | Документация',
        description:
          'Проверка распознавания аудиофайлов, GraphQL API, доступ, настройка и ограничения.',
        noindex: true,
        path: '/docs/transcription',
      })

export default TranscriptionDocumentationPage
