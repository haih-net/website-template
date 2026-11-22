export interface PcmRecording {
  stop(): Promise<void>
}

export async function recordPcm(
  send: (audio: ArrayBuffer) => void,
): Promise<PcmRecording> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Микрофон требует HTTPS или localhost')
  }
  const context = new AudioContext({ sampleRate: 24000 })
  await context.resume()
  let stream: MediaStream | undefined
  let node: AudioWorkletNode | undefined
  let source: MediaStreamAudioSourceNode | undefined
  let stopped = false
  const worklet = `class Capture extends AudioWorkletProcessor {
    constructor() { super(); this.samples = []; this.stopped = false;
      this.port.onmessage = () => { this.flush(); this.stopped = true; this.port.postMessage('stopped'); }; }
    flush() { if (!this.samples.length) return; const pcm = new Int16Array(this.samples.length);
      for (let i = 0; i < pcm.length; i++) { const x = Math.max(-1, Math.min(1, this.samples[i])); pcm[i] = x < 0 ? x * 32768 : x * 32767; }
      this.samples = []; this.port.postMessage(pcm.buffer, [pcm.buffer]); }
    process(inputs) { if (this.stopped) return false; const audio = inputs[0]?.[0];
      if (audio) { for (const x of audio) this.samples.push(x); if (this.samples.length >= 2400) this.flush(); }
      return true; }
  } registerProcessor('voice-capture', Capture);`

  const url = URL.createObjectURL(
    new Blob([worklet], { type: 'text/javascript' }),
  )

  try {
    if (context.sampleRate !== 24000) {
      throw new Error('Браузер не поддерживает запись 24 кГц')
    }
    await context.audioWorklet.addModule(url)
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
      video: false,
    })
    source = context.createMediaStreamSource(stream)
    node = new AudioWorkletNode(context, 'voice-capture')
    const silent = context.createGain()
    silent.gain.value = 0
    source.connect(node).connect(silent).connect(context.destination)
    let flushed: (() => void) | undefined
    node.port.onmessage = (event) => {
      if (event.data === 'stopped') {
        flushed?.()
        return
      }
      if (event.data instanceof ArrayBuffer) {
        send(event.data)
      }
    }
    return {
      async stop() {
        if (stopped) {
          return
        }
        stopped = true
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, 500)
          flushed = () => {
            clearTimeout(timeout)
            resolve()
          }
          node?.port.postMessage('stop')
        })
        stream?.getTracks().forEach((track) => track.stop())
        source?.disconnect()
        node?.disconnect()
        await context.close()
      },
    }
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop())
    await context.close()
    throw error
  } finally {
    URL.revokeObjectURL(url)
  }
}
