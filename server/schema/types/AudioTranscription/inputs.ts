import { builder } from 'server/schema/builder'

export const TranscribeAudioInput = builder.inputType('TranscribeAudioInput', {
  fields: (t) => ({
    file: t.field({ type: 'Upload', required: true }),
    language: t.string(),
  }),
})
