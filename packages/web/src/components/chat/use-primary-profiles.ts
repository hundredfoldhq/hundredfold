import { useFallbackChains } from '@/hooks/use-fallback-chains'
import type { FallbackChainsResponse } from '@hundredfold/fallback-chain-wire'
import { effectivePrimaryProfile, startableProfileNames } from './new-chat-helpers'

/** Whether the chat's subject (its employee, else the Claude engine) has a chain opening with a group that holds its own account. */
function hasHomeGroup(chains: FallbackChainsResponse | undefined, employee: string | undefined): boolean {
  const [kind, id] = employee ? ['employee', employee] : ['engine', 'claude']
  return chains?.subjects?.find((s) => s.kind === kind && s.id === id)?.startPick !== undefined
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
    /** Rows to offer; empty while unconfirmed or for a remote employee. */
    profiles: employeeRemote || !declared ? [] : declared,
    effective: enabled ? effectivePrimaryProfile({ profile, declared, employeeRemote }) : undefined,
  }
}
