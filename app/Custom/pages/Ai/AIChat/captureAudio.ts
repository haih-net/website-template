export interface VoiceCapture {
  sdp: string
  acceptAnswer(sdp: string): Promise<void>
  setListening(enabled: boolean): void
  mute(): void
  stop(): void
}

export async function captureAudio(
  onConnectionChange: (connected: boolean) => void,
  onFailure: (message: string) => void,
): Promise<VoiceCapture> {
  if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
    throw new Error(
      'Микрофон доступен через HTTPS или localhost в браузере с поддержкой WebRTC.',
    )
  }
  // resume вызывается в обработчике первого клика, до ожидания сети и микрофона.
  const context = new AudioContext()
  const resumed = context.resume()
  let stream: MediaStream | undefined
  let source: MediaStreamAudioSourceNode | undefined
  const peer = new RTCPeerConnection()
  const playback = new Audio()
  // Как в звонках: медиэлемент запускает WebRTC playout в Chromium,
  // но единственный слышимый выход проходит через AudioContext.
  playback.volume = 0
  let muted = false
  let stopped = false
  let connected = false
  const setListening = (enabled: boolean): void => {
    for (const track of stream?.getTracks() ?? []) {
      track.enabled = enabled && connected && !stopped && !muted
    }
  }

  let disconnectTimer: ReturnType<typeof setTimeout> | undefined
  const mute = (): void => {
    muted = true
    playback.pause()
    playback.srcObject = null
    source?.disconnect()
    stream?.getTracks().forEach((track) => track.stop())
  }

  const stop = (): void => {
    stopped = true
    clearTimeout(disconnectTimer)
    mute()
    peer.ontrack = null
    playback.onerror = null
    context.onstatechange = null
    void context
      .close()
      .catch((error: unknown) =>
        console.error('Не удалось закрыть аудиоконтекст', error),
      )
    peer.close()
  }

  try {
    const playbackFailed = (): void => {
      if (!stopped && !muted) {
        onFailure(
          'Не удалось воспроизвести ответ. Разрешите звук для сайта в настройках браузера и включите голосовой режим снова.',
        )
      }
    }

    await resumed.catch(() => {
      throw new Error(
        'Не удалось включить звук. Разрешите звук для сайта и включите голосовой режим снова.',
      )
    })
    if (context.state !== 'running') {
      throw new Error(
        'Звук приостановлен браузером. Включите голосовой режим повторным нажатием.',
      )
    }
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
      video: false,
    })
    context.onstatechange = () => {
      if (!stopped && !muted && context.state !== 'running') {
        onFailure('Браузер приостановил звук. Включите голосовой режим снова.')
      }
    }
    playback.onerror = playbackFailed
    peer.ontrack = ({ track }) => {
      if (stopped || muted || track.kind !== 'audio') {
        return
      }
      try {
        source?.disconnect()
        const incoming = new MediaStream([track])
        source = context.createMediaStreamSource(incoming)
        source.connect(context.destination)
        playback.srcObject = incoming
        void playback.play().catch(playbackFailed)
      } catch {
        playbackFailed()
      }
    }
    for (const track of stream.getTracks()) {
      track.enabled = false
      peer.addTrack(track, stream)
      track.onended = () => {
        if (!stopped) {
          onFailure(
            'Микрофон отключён. Подключите его и включите голосовой режим снова.',
          )
        }
      }
    }
    const events = peer.createDataChannel('oai-events')
    const updateConnection = (): void => {
      if (stopped || muted) {
        return
      }
      const ready =
        peer.connectionState === 'connected' &&
        (peer.iceConnectionState === 'connected' ||
          peer.iceConnectionState === 'completed') &&
        events.readyState === 'open'

      if (!ready) {
        setListening(false)
      }
      if (connected !== ready) {
        connected = ready
        onConnectionChange(ready)
      }
      if (ready) {
        clearTimeout(disconnectTimer)
        disconnectTimer = undefined
      } else if (
        peer.connectionState === 'failed' ||
        peer.connectionState === 'closed' ||
        peer.iceConnectionState === 'failed' ||
        events.readyState === 'closed'
      ) {
        onFailure(
          'Аудиосоединение прервано. Проверьте сеть и включите голосовой режим снова.',
        )
      } else if (
        !disconnectTimer &&
        (peer.connectionState === 'disconnected' ||
          peer.iceConnectionState === 'disconnected')
      ) {
        disconnectTimer = setTimeout(
          () =>
            onFailure(
              'Аудиосоединение прервано. Включите голосовой режим снова.',
            ),
          10000,
        )
      }
    }

    peer.onconnectionstatechange = updateConnection
    peer.oniceconnectionstatechange = updateConnection
    events.onopen = updateConnection
    events.onclosing = updateConnection
    events.onclose = updateConnection
    events.onerror = () => {
      if (!stopped && !muted) {
        onFailure(
          'Канал голосового сеанса недоступен. Включите голосовой режим снова.',
        )
      }
    }
    const offer = await peer.createOffer()
    await peer.setLocalDescription(offer)
    if (!offer.sdp) {
      throw new Error('Не удалось подготовить аудиосоединение.')
    }
    return {
      sdp: offer.sdp,
      acceptAnswer: async (sdp) => {
        await peer.setRemoteDescription({ type: 'answer', sdp })
      },
      setListening,
      mute,
      stop,
    }
  } catch (error) {
    stop()
    throw error
  }
}
