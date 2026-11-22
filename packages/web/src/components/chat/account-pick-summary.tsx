import type { AccountPick } from '@hundredfold/fallback-chain-wire'
import { DropdownMenuLabel } from '@/components/ui/dropdown-menu'
import { headroomLine, pickedLabel, pickReasonText, pickTriggerText } from '@/lib/account-pick-format'

/**
 * Which account a balanced session was pinned to and why: the sentence, when it was picked, and
 * each account of the group with its headroom and the share of new sessions it earned. A
 * department-scoped viewer is sent the pick without the numbers, and this reads from the
 * accounts, their states and the reason alone.
 */
export function AccountPickSummary({ pick }: { pick: AccountPick }) {
  return (
    <>
      <DropdownMenuLabel className="pt-1 pb-1.5 text-[length:var(--text-caption2)] font-[var(--weight-bold)] uppercase tracking-[0.4px] text-[var(--text-quaternary)]">
        Account
      </DropdownMenuLabel>
      <DropdownMenuLabel data-testid="account-pick" className="flex flex-col gap-[2px] pb-1.5 pt-0 font-normal">
        <span data-testid="account-pick-account" className="text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
          Pinned to {pickedLabel(pick)}
        </span>
        <span data-testid="account-pick-reason" className="text-[length:var(--text-caption1)] text-[var(--text-secondary)]">{pickReasonText(pick)}</span>
        <span data-testid="account-pick-when" className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">{pickTriggerText(pick)}</span>
        {pick.candidates.length > 1 && (
          <ul data-testid="account-pick-candidates" className="m-0 mt-[2px] flex list-none flex-col gap-[1px] p-0">
            {pick.candidates.map((candidate) => (
              <li
                key={candidate.account}
                data-picked={candidate.account === pick.picked || undefined}
                className="flex justify-between gap-2 text-[length:var(--text-caption2)] text-[var(--text-tertiary)]"
              >
                <span className={candidate.account === pick.picked ? 'font-[var(--weight-medium)] text-[var(--text-secondary)]' : undefined}>{candidate.label}</span>
                <span className="text-right">{headroomLine(candidate)}</span>
              </li>
            ))}
          </ul>
        )}
      </DropdownMenuLabel>
    </>
  )
}
