import { expect, it, vi } from 'vitest'
import { issueSessionToken } from '../../../codex/helpers/sessionToken'
import { hasCodexChatToken } from './hasCodexChatToken'
import type { Context } from '../../builder'

vi.mock('../../../codex/helpers/connectCodex', () => ({
  codexSecret: () => 'test-voice-token-secret',
}))
it('разрешает анонимного владельца токена чата, но не отсутствие токена или подделку', () => {
  const context = (token?: string): Context =>
    ({ req: { headers: token ? { 'dialog-token': token } : {} } }) as Context

  expect(hasCodexChatToken(context())).toBe(false)
  expect(hasCodexChatToken(context('forged'))).toBe(false)
  expect(hasCodexChatToken(context(issueSessionToken('session')))).toBe(true)
})
