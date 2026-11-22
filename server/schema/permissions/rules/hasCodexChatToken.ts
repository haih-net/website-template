import type { Context } from 'server/schema/builder'
import { verifySessionToken } from 'server/codex/helpers/sessionToken'

export function codexChatSession(ctx: Context): string | null {
  const token = ctx.req?.headers?.['dialog-token']
  return verifySessionToken(typeof token === 'string' ? token : undefined)
}

export function hasCodexChatToken(ctx: Context): boolean {
  return codexChatSession(ctx) !== null
}
