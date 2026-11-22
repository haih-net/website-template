import { describe, expect, it } from 'vitest'
import { SpeechChunks } from './speechChunks'

describe('Потоковые речевые порции', () => {
  it('выдаёт порцию до завершения ответа и сохраняет разделитель между чанками', () => {
    const chunks: string[] = []
    const parser = new SpeechChunks((text) => chunks.push(text))
    parser.append('Первая реплика.\n\n-')
    parser.append('--\n\nВторая')
    expect(chunks).toEqual(['Первая реплика.'])
    parser.append(' реплика.')
    parser.finish()
    expect(chunks).toEqual(['Первая реплика.', 'Вторая реплика.'])
  })
  it('не произносит код, URL и отменённый хвост', () => {
    const chunks: string[] = []
    const parser = new SpeechChunks((text) => chunks.push(text))
    parser.append('Смотрите пример.\n\n```ts\n---\nconst x = 1\n```\n\n---\n')
    parser.append(
      '| Колонка |\n| --- |\n| Техническое содержимое |\n\nhttps://example.com\n\n---\n',
    )
    parser.append('Незаконченная реплика')
    parser.cancel()
    expect(chunks).toEqual(['Смотрите пример.'])
  })
})
