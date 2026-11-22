import { hasCodexChatToken } from './rules/hasCodexChatToken'
import type { Context } from 'server/schema/builder'
import { isSudo } from './rules/isSudo'
import { isActive } from './rules/isActive'
import { hasChatToken, type ChatAccessArgs } from './rules/hasChatToken'

export interface AuthScopes {
  codexChatToken: boolean
  sudo: boolean
  active: boolean
  chatToken: ChatAccessArgs
}

interface ScopeLoaders {
  codexChatToken: boolean
  sudo: boolean
  active: boolean
  chatToken: (args: ChatAccessArgs) => Promise<boolean>
}

export function authScopes(ctx: Context): ScopeLoaders {
  return {
    codexChatToken: hasCodexChatToken(ctx),
    sudo: isSudo(ctx),
    active: isActive(ctx),
    chatToken: (args) => hasChatToken(args, ctx),
  }
}
