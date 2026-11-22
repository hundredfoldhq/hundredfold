import type { FallbackGroupEntry } from "@hundredfold/fallback-chain-wire"
import { accountOf, groupAccountOptions, withMember } from "./chain-links"
import type { RowFields } from "./chain-row"

/** What a group is, said once under its row so the rows around it are read right. */
export const GROUP_HINT = "Balanced: new sessions spread across these accounts by usage headroom. When a limit hits, the rest of the group is tried first, most headroom first."

/**
 * One balanced group: the Claude accounts it holds, ticked from the default login and the declared
 * accounts. Members keep the order written and a newly ticked account goes last; the gateway
 * orders them by headroom, so the order here carries no meaning beyond tie-breaking.
 */
export function GroupTarget({ group, index, fields, onChange }: {
  group: FallbackGroupEntry
  index: number
  fields: RowFields
  onChange: (group: FallbackGroupEntry) => void
}) {
  const at = `link ${index + 1} of the ${fields.chainName}`
  const held = new Set(group.group.map(accountOf))
  const offered = groupAccountOptions(fields.profiles, fields.profileLabels)
  // An account the group holds that the chain is not offered (a remote one, an undeclared name) stays visible as written, so it can be unticked.
  const options = [...offered, ...group.group.map(accountOf).filter((name) => !offered.some((o) => o.value === name)).map((name) => ({ value: name, label: name }))]
  return (
    <div data-chain-group className="flex w-full min-w-0 flex-col gap-[var(--space-1)] py-[4px] @[560px]/chain:flex-1">
      <span className="text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-primary)]">Balanced group</span>
      <div role="group" aria-label={`Accounts of ${at}`} className="flex flex-wrap gap-x-[var(--space-3)] gap-y-[2px]">
        {options.map((option) => (
          <label key={option.value || "default-login"} className="inline-flex min-h-[28px] cursor-pointer items-center gap-[6px] text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
            <input
              type="checkbox"
              checked={held.has(option.value)}
              aria-label={`${option.label} in ${at}`}
              onChange={(event) => onChange(withMember(group, option.value, event.target.checked))}
              style={{ accentColor: "var(--accent)" }}
            />
            {option.label}
          </label>
        ))}
      </div>
      <span data-chain-group-hint className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">{GROUP_HINT}</span>
    </div>
  )
}
