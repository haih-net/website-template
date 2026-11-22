import { afterEach, expect, it, vi } from 'vitest'
import { captureAudio } from './captureAudio'

afterEach(() => vi.unstubAllGlobals())

it('воспроизводит через AudioContext, сообщает отказ play и освобождает медиаресурсы', async () => {
  const microphone = { stop: vi.fn(), enabled: true }
  const remote = { kind: 'audio', stop: vi.fn() }
  const playback = {
    srcObject: null,
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    onerror: null,
  }

  const peer = {
    addTrack: vi.fn(),
    createDataChannel: vi.fn(() => ({ readyState: 'connecting' })),
    createOffer: async () => ({ sdp: 'v=0' }),
    setLocalDescription: vi.fn(),
    close: vi.fn(),
    ontrack: null as null | ((event: { track: typeof remote }) => void),
  }

  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: async () => ({ getTracks: () => [microphone] }),
    },
  })
  vi.stubGlobal('window', { RTCPeerConnection: true })
  vi.stubGlobal(
    'RTCPeerConnection',
    class {
      constructor() {
        return peer
      }
    },
  )
  vi.stubGlobal(
    'Audio',
    class {
      constructor() {
        return playback
      }
    },
  )
  vi.stubGlobal(
    'MediaStream',
    class {
      addTrack = vi.fn()
      getTracks = () => [remote]
    },
  )
  const source = { connect: vi.fn(), disconnect: vi.fn() }
  const context = {
    resume: vi.fn().mockResolvedValue(undefined),
    state: 'running',
    createMediaStreamSource: vi.fn(() => source),
    destination: {},
    close: vi.fn().mockResolvedValue(undefined),
  }

  vi.stubGlobal(
    'AudioContext',
    class {
      constructor() {
        return context
      }
    },
  )
  const failure = vi.fn()
  const capture = await captureAudio(vi.fn(), failure)
  peer.ontrack?.({ track: remote })
  expect(context.resume).toHaveBeenCalledOnce()
  expect(source.connect).toHaveBeenCalledWith(context.destination)
  expect(playback.play).toHaveBeenCalledOnce()
  playback.play.mockRejectedValueOnce(new Error('Autoplay denied'))
  peer.ontrack?.({ track: remote })
  await vi.waitFor(() =>
    expect(failure).toHaveBeenCalledWith(
      expect.stringContaining('Разрешите звук'),
    ),
  )
  capture.mute()
  expect(playback.pause).toHaveBeenCalled()
  expect(playback.srcObject).toBeNull()
  capture.stop()
  expect(microphone.stop).toHaveBeenCalled()
  expect(source.disconnect).toHaveBeenCalled()
  expect(context.close).toHaveBeenCalled()
  expect(peer.close).toHaveBeenCalled()
})

it('при отказе AudioContext сообщает ошибку и закрывает соединение до доступа к микрофону', async () => {
  const getUserMedia = vi.fn()
  const context = {
    resume: vi.fn().mockRejectedValue(new Error('Not allowed')),
    close: vi.fn().mockResolvedValue(undefined),
  }

  const peer = { close: vi.fn() }
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
  vi.stubGlobal('window', { RTCPeerConnection: true })
  vi.stubGlobal(
    'AudioContext',
    class {
      constructor() {
        return context
      }
    },
  )
  vi.stubGlobal(
    'RTCPeerConnection',
    class {
      constructor() {
        return peer
      }
    },
  )
  vi.stubGlobal(
    'Audio',
    class {
      pause = vi.fn()
    },
  )
  await expect(captureAudio(vi.fn(), vi.fn())).rejects.toThrow(
    'Не удалось включить звук',
  )
  expect(getUserMedia).not.toHaveBeenCalled()
  expect(context.close).toHaveBeenCalled()
  expect(peer.close).toHaveBeenCalled()
})
