import type * as React from 'react'
import { useCallback } from 'react'
import { Link } from 'react-router'
import { FormProvider, useForm, useController } from 'react-hook-form'
import { yupResolver } from '@hookform/resolvers/yup'
import * as yup from 'yup'
import {
  useTranscribeAudioMutation,
  type TranscribeAudioMutationVariables,
} from 'app/gql/generated'
import { getCodexChatToken } from 'app/Custom/components/Chat/lib/streamClient'
import { Button } from 'app/Custom/components/Button'
import { DocumentationStyled } from '../styles'
import { TranscriptionForm } from './styles'

type FormData = TranscribeAudioMutationVariables['data']
const schema: yup.ObjectSchema<FormData> = yup.object({
  file: yup
    .mixed<File>()
    .required('Выберите аудиофайл')
    .test(
      'size',
      'Файл должен быть не больше 25 МиБ',
      (value) => !value || value.size <= 25 * 1024 * 1024,
    ),
  language: yup.string().nullable(),
})

export const TranscriptionDocumentationPage: React.FC = () => {
  const form = useForm<FormData>({
    resolver: yupResolver(schema),
    defaultValues: { language: 'ru' },
  })
  const { field } = useController({ control: form.control, name: 'file' })
  const [transcribe, result] = useTranscribeAudioMutation()
  const onFile = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>): void => {
      field.onChange(event.target.files?.[0])
      result.reset()
    },
    [field, result],
  )

  const submit = useCallback(
    async (data: FormData): Promise<void> => {
      form.clearErrors('root')
      try {
        const token = await getCodexChatToken()
        await transcribe({
          variables: { data },
          context: {
            headers: {
              'dialog-token': token,
              'Apollo-Require-Preflight': 'true',
            },
          },
        })
      } catch (error) {
        form.setError('root', {
          message:
            error instanceof Error
              ? error.message
              : 'Не удалось распознать файл',
        })
      }
    },
    [form, transcribe],
  )

  return (
    <DocumentationStyled>
      <nav aria-label="Документация">
        <Link to="/docs">Документация</Link>
      </nav>
      <h1 tabIndex={-1}>Транскрибация аудио</h1>
      <p>
        Самостоятельная функция распознавания аудиофайла. Она возвращает текст,
        не создаёт диалог с агентом и не отправляет ему содержимое записи.
      </p>
      <h2>Проверить файл</h2>
      <p>
        Выберите аудио или видео со звуковой дорожкой. Запись передаётся в
        сервис диктовки ChatGPT с серверной авторизацией. Для этой проверки
        выбран русский язык.
      </p>
      <FormProvider {...form}>
        <TranscriptionForm onSubmit={form.handleSubmit(submit)}>
          <label htmlFor="transcription-file">Аудиофайл</label>
          <input
            id="transcription-file"
            type="file"
            accept="audio/*,video/*"
            name={field.name}
            ref={field.ref}
            onBlur={field.onBlur}
            onChange={onFile}
            disabled={form.formState.isSubmitting}
          />
          {form.formState.errors.file && (
            <p role="alert">{String(form.formState.errors.file.message)}</p>
          )}
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? 'Распознаём…' : 'Расшифровать файл'}
          </Button>
          {form.formState.errors.root && (
            <p role="alert">{form.formState.errors.root.message}</p>
          )}
          {result.data && (
            <section aria-live="polite">
              <h3>Результат</h3>
              <p>
                Длительность:{' '}
                {result.data.transcribeAudio.durationSeconds.toFixed(1)} с.
              </p>
              <pre>{result.data.transcribeAudio.text}</pre>
            </section>
          )}
        </TranscriptionForm>
      </FormProvider>
      <h2>API и доступ</h2>
      <p>
        GraphQL-мутация{' '}
        <code>transcribeAudio(data: TranscribeAudioInput!)</code> принимает{' '}
        <code>file: Upload!</code> и необязательный <code>language</code> (по
        умолчанию <code>ru</code>). Для загрузки используется multipart; на
        фронте — сгенерированный <code>TranscribeAudioDocument</code> или{' '}
        <code>useTranscribeAudioMutation</code>.
      </p>
      <p>
        Доступ разрешён в том числе анонимному владельцу подписанного токена
        Codex-чата. Токен получается через <code>POST /api/codex/token</code> и
        передаётся в заголовке <code>dialog-token</code>. Для multipart нужен
        заголовок <code>Apollo-Require-Preflight: true</code>. Правило доступа —{' '}
        <code>codexChatToken</code>; legacy-токен чата не подходит.
      </p>
      <p>
        Ответ содержит <code>text</code>, <code>language</code>,{' '}
        <code>durationSeconds</code> и <code>completed</code>. Возвращается один
        окончательный результат без потока GraphQL. Создание токена само по себе
        не создаёт агентный контекст.
      </p>
      <h2>Ограничения и настройка</h2>
      <ul>
        <li>
          Непустой файл до 25 МиБ и запись до 240 секунд. Поддерживается звук,
          который может декодировать установленный ffmpeg; длинные записи не
          обрезаются молча.
        </li>
        <li>
          Одна транскрибация на сессию, до четырёх одновременно на процесс
          веб-сервера. Временный файл удаляется после результата, ошибки или
          отмены.
        </li>
        <li>
          На сервере нужны ffmpeg и действующая ChatGPT-авторизация в{' '}
          <code>TRANSCRIBE_AUTH_FILE</code>. Без явного пути используется
          auth.json из CODEX_HOME или ~/.codex. Авторизация распознавания
          независима от OpenRouter-профиля текстового агента.
        </li>
        <li>
          Аудио передаётся распознавателю примерно в темпе записи; обработка не
          мгновенная. Общий лимит обработки — 330 секунд, прокси должен ждать
          ответ до 360 секунд.
        </li>
        <li>
          Используется внутренний ChatGPT dictation. Его протокол и доступность
          могут измениться; это не публичный API транскрибации OpenRouter.
        </li>
      </ul>
      <h2>Локальный инструмент</h2>
      <p>
        <code>
          npm run transcribe:audio -- /absolute/audio.mp3 --language ru --json
        </code>{' '}
        вызывает то же ядро. <code>npm run transcribe:mcp</code> запускает MCP
        stdio с инструментом <code>transcribe_audio</code> и аргументами{' '}
        <code>filePath</code>, <code>language</code>. Локальный MCP не
        предоставляет посетителю доступ к серверным файлам.
      </p>
      <h2>Отличие от живой диктовки</h2>
      <p>
        Микрофон в чате передаёт аудио во время записи. Файловая функция
        обрабатывает уже выбранный файл. В проверенном живом сервисе события
        speech.stopped и transcript.final приходили только после session.close,
        даже после шести секунд цифровой тишины. Автоматическое завершение
        реплики по паузе не подтверждено; исследование отложено. Явная остановка
        и отправка записи работают независимо от этого ограничения.
      </p>
    </DocumentationStyled>
  )
}
