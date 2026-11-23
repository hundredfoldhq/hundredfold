import { useRef } from "react"
import { fallbackLinkKey, type FallbackGroupEntry } from "@hundredfold/fallback-chain-wire"
import { accountLink, groupAccountOptions, groupEngineOf, opencodeGroupAccountOptions, withMember, type GroupAccountOption } from "./chain-links"
import type { RowFields } from "./chain-row"

/** What a group is, said once under its row so the rows around it are read right. */
export const GROUP_HINT = "Balanced: new sessions spread across these accounts by usage headroom. When a limit hits, the rest of the group is tried first, most headroom first."

/** The same for a group of opencode accounts: a session keeps its model, only the account that serves it moves. */
export const OPENCODE_GROUP_HINT = "Balanced: new sessions spread across these opencode accounts by usage headroom, each running the model it was started on. When a limit hits, the rest of the group is tried first, most headroom first."

type GroupKind = "claude" | "opencode"

/** The accounts a group of this kind is ticked from; a group that mixes engines (the gateway refuses it) offers both, so the extra accounts can be unticked. */
function offeredFor(kind: GroupKind | "mixed", fields: RowFields): GroupAccountOption[] {
  const claude = groupAccountOptions(fields.profiles, fields.profileLabels)
  const opencode = opencodeGroupAccountOptions((fields.opencodeAccounts ?? []).map((account) => account.name))
  if (kind === "claude") return claude
  return kind === "opencode" ? opencode : [...claude, ...opencode]
}

/**
 * One balanced group: the accounts it holds, ticked from the default login and the declared Claude
 * accounts, or (a group of opencode accounts) from the declared opencode accounts. Members keep the
 * order written and a newly ticked account goes last; the gateway orders them by headroom, so the order
 * here carries no meaning beyond tie-breaking.
 */
export function GroupTarget({ group, index, fields, onChange }: {
  group: FallbackGroupEntry
  index: number
  fields: RowFields
  onChange: (group: FallbackGroupEntry) => void
}) {
  const at = `link ${index + 1} of the ${fields.chainName}`
  // An emptied opencode group stays an opencode group while the row is open: the kind is what the row was last shown with.
  const last = useRef<GroupKind>("claude")
  const engine = groupEngineOf(group)
  if (engine) last.current = engine
  const kind: GroupKind | "mixed" = group.group.length === 0 ? last.current : (engine ?? "mixed")
  const held = new Set(group.group.map(fallbackLinkKey))
  const offered = offeredFor(kind, fields)
  const key = (option: GroupAccountOption) => fallbackLinkKey(accountLink(option.value, option.engine))
  // An account the group holds that the chain is not offered (a remote one, an undeclared name) stays visible as written, so it can be unticked.
  const options: GroupAccountOption[] = [
    ...offered,
    ...group.group
      .filter((member) => !offered.some((o) => key(o) === fallbackLinkKey(member)))
      .map((member): GroupAccountOption => ({ engine: member.engine === "opencode" ? "opencode" : "claude", value: member.profile ?? "", label: member.profile ?? member.engine })),
  ]
  const title = kind === "opencode" ? "Balanced opencode group" : "Balanced group"
  return (
    <div data-chain-group={kind} className="flex w-full min-w-0 flex-col gap-[var(--space-1)] py-[4px] @[560px]/chain:flex-1">
      <span className="text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-primary)]">{title}</span>
      <div role="group" aria-label={`Accounts of ${at}`} className="flex flex-wrap gap-x-[var(--space-3)] gap-y-[2px]">
        {options.map((option) => (
          <label key={key(option)} className="inline-flex min-h-[28px] cursor-pointer items-center gap-[6px] text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
            <input
              type="checkbox"
              checked={held.has(key(option))}
              aria-label={`${option.label} in ${at}`}
              onChange={(event) => onChange(withMember(group, accountLink(option.value, option.engine), event.target.checked))}
              style={{ accentColor: "var(--accent)" }}
            />
            {option.label}
          </label>
        ))}
      </div>
      <span data-chain-group-hint className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">{kind === "opencode" ? OPENCODE_GROUP_HINT : GROUP_HINT}</span>
    </div>
  )
}
