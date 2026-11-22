import { useFallbackChains } from '@/hooks/use-fallback-chains'
import type { FallbackChainsResponse } from '@hundredfold/fallback-chain-wire'
import { pickEngine } from '@/lib/account-pick-format'
import { effectivePrimaryProfile, startableProfileNames } from './new-chat-helpers'

/** The pick a new session of the chat's subject (its employee, else the engine) would make now, when its chain opens with a group that holds its own account. */
function startPickOf(chains: FallbackChainsResponse | undefined, employee: string | undefined, engine: 'claude' | 'opencode') {
  const [kind, id] = employee ? ['employee', employee] : ['engine', engine]
  return chains?.subjects?.find((s) => s.kind === kind && s.id === id)?.startPick
}

/** Whether the chat's subject (its employee, else the Claude engine) has a chain opening with a group of Claude accounts that holds its own. An opencode group is the opencode rows' to say. */
function hasHomeGroup(chains: FallbackChainsResponse | undefined, employee: string | undefined): boolean {
  const pick = startPickOf(chains, employee, 'claude')
  return pick !== undefined && pickEngine(pick) === 'claude'
}

/** The provider a model id is served under: `opencode-go/glm-5` is `opencode-go`. */
function providerOf(model: string | undefined): string | undefined {
  const slash = model ? model.indexOf('/') : -1
  return model && slash > 0 ? model.slice(0, slash) : undefined
}

/**
 * The provider whose account a new opencode session is balanced from: the provider of the subject's own
 * model, when its chain opens with a group of opencode accounts that holds it. A model on that provider is
 * balanced; a model on any other account chooses that account.
 */
function balancedOpencodeProvider(chains: FallbackChainsResponse | undefined, employee: string | undefined): string | undefined {
  const [kind, id] = employee ? ['employee', employee] : ['engine', 'opencode']
  const subject = chains?.subjects?.find((s) => s.kind === kind && s.id === id)
  if (!subject?.startPick || pickEngine(subject.startPick) !== 'opencode') return undefined
  return providerOf(subject.primary?.model)
}

/**
 * The declared Claude accounts a new chat may start on, and the remembered
 * profile only if it may actually be sent: confirmed declared and the employee
 * local. The stored choice is never rewritten here, so a chains read that has not
 * loaded (or failed), a removed account or a remote employee just yields no
 * profile until it is valid again.
 *
 * `balanced` is true when the chat's subject (its employee, else the Claude engine) has a chain that
 * opens with a group holding its own account: a new session then starts on the account the balancer
 * picks, so the default option is that split rather than the own login.
 */
export function usePrimaryProfiles(enabled: boolean, profile: string | undefined, employeeRemote: boolean | undefined, employee?: string) {
  const { data: chains } = useFallbackChains(employee, enabled)
  const declared = enabled ? startableProfileNames(chains) : undefined
  return {
    /** The default option spreads new sessions across a group by headroom. */
    balanced: enabled && !employeeRemote && hasHomeGroup(chains, employee),
    /** The provider a new opencode session is balanced from (a remote employee's too: the gateway reads the readings), or undefined. */
    balancedProvider: enabled ? balancedOpencodeProvider(chains, employee) : undefined,
    /** Rows to offer; empty while unconfirmed or for a remote employee. */
    profiles: employeeRemote || !declared ? [] : declared,
    effective: enabled ? effectivePrimaryProfile({ profile, declared, employeeRemote }) : undefined,
  }
}
