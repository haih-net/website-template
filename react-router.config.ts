import type { Config } from '@react-router/dev/config'
export default {
  ssr: true,
  prerender: ['/', '/docs', '/docs/video-calls', '/docs/transcription'],
  routeDiscovery: { mode: 'initial' },
} satisfies Config
