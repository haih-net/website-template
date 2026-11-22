const active = new Set<string>()

export function acquireTranscription(sessionId: string): () => void {
  if (active.has(sessionId) || active.size >= 4) {
    throw new Error('Дождитесь завершения текущей транскрибации')
  }
  active.add(sessionId)
  return () => {
    active.delete(sessionId)
  }
}
