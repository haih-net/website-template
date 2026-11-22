import { describe, expect, it } from 'vitest'
import { TranscriptCollector } from './dictationProtocol'
import { transcribeAudio } from './transcribeAudio'

describe('Сборка финальной транскрипции', () => {
  it('сохраняет порядок речи при обратном порядке ответов и выбирает последнюю ревизию', () => {
    const collector = new TranscriptCollector()
    collector.accept({ type: 'speech.started', utterance_id: 'first' })
    collector.accept({ type: 'speech.started', utterance_id: 'second' })
    collector.accept({
      type: 'transcript.final',
      utterance_id: 'second',
      revision: 2,
      text: 'Второе.',
    })
    collector.accept({
      type: 'transcript.final',
      utterance_id: 'first',
      revision: 3,
      text: 'Первое.',
    })
    collector.accept({
      type: 'transcript.final',
      utterance_id: 'first',
      revision: 1,
      text: 'Устаревшее.',
    })
    expect(collector.finish().map((segment) => segment.text)).toEqual([
      'Первое.',
      'Второе.',
    ])
  })

  it('не выдаёт промежуточный или отсутствующий текст за полный результат', () => {
    const collector = new TranscriptCollector()
    collector.accept({ type: 'speech.started', utterance_id: 'first' })
    collector.accept({
      type: 'transcript.segment',
      utterance_id: 'first',
      revision: 1,
      text: 'Начало',
    })
    expect(() => collector.finish()).toThrow('без финального текста')
  })

  it('отклоняет URL до обращения к авторизации и сервису', async () => {
    await expect(
      transcribeAudio({ filePath: 'https://example.com/audio.ogg' }),
    ).rejects.toThrow('абсолютный путь')
  })
})
