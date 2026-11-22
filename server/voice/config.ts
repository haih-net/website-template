export type VoiceMode = 'off' | 'realtime' | 'messages'

export function voiceMode(): VoiceMode {
  const mode = process.env.VOICE_MODE ?? 'off'
  if (mode !== 'off' && mode !== 'realtime' && mode !== 'messages') {
    throw new Error('VOICE_MODE должен быть off, realtime или messages')
  }
  return mode
}
