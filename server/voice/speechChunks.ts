import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import type { RootContent } from 'mdast'

const parser = unified().use(remarkParse).use(remarkGfm)

/** Разрешаем только готовую устную речь; код и техническая разметка не озвучиваются. */
function speechText(text: string): string {
  const tree = parser.parse(text)
  const plain = (node: RootContent): string => {
    if (node.type === 'text') {
      return node.value.replace(/https?:\/\/\S+/g, '')
    }
    if (
      node.type === 'paragraph' ||
      node.type === 'emphasis' ||
      node.type === 'strong'
    ) {
      return node.children.map((child) => plain(child as RootContent)).join('')
    }
    return ''
  }

  return tree.children.map(plain).filter(Boolean).join('\n').trim()
}

export class SpeechChunks {
  private buffer = ''
  constructor(private readonly emit: (text: string) => void) {}

  append(delta: string): void {
    this.buffer += delta
    if (this.buffer.length > 16000) {
      throw new Error('Речевая порция слишком большая')
    }
    // Markdown-парсер отличает thematicBreak от --- внутри кода и setext heading.
    const tree = parser.parse(this.buffer)
    let consumed = 0
    for (const node of tree.children) {
      if (node.type !== 'thematicBreak' || !node.position) {
        continue
      }
      const start = node.position.start.offset ?? 0
      const end = node.position.end.offset ?? 0
      if (
        this.buffer.slice(start, end).trim() !== '---' ||
        this.buffer[end] !== '\n'
      ) {
        continue
      }
      this.output(this.buffer.slice(consumed, start))
      consumed = end + 1
    }
    this.buffer = this.buffer.slice(consumed)
  }

  finish(): void {
    this.output(this.buffer)
    this.buffer = ''
  }
  cancel(): void {
    this.buffer = ''
  }
  private output(value: string): void {
    const text = speechText(value)
    if (text) {
      this.emit(text)
    }
  }
}
