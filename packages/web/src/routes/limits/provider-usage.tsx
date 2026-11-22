import { AlertTriangle } from "@/components/ui/icon"
import type { EngineLimitBucket, ProviderUsage } from "@/lib/api"
import { ModelBuckets, WindowRow } from "./opencode-account-parts"

function money(value: number): string {
  return `$${Number.isInteger(value) ? value : value.toFixed(2)}`
}

/** The month's dollars, only when the gateway could price them (a monthly allowance is configured); the provider itself reports percentages. */
function dollarLine(usage: ProviderUsage): string | null {
  if (usage.monthlyLimitUsd === undefined || usage.consumedUsd === undefined || usage.remainingUsd === undefined) return null
  return `${money(usage.consumedUsd)} of ${money(usage.monthlyLimitUsd)} used this month · ${money(usage.remainingUsd)} left`
}

/** What the provider reports of the plan, window by window, or why it cannot: never a zero nobody measured. */
export function ProviderUsagePanel({ usage, now }: { usage: ProviderUsage; now: number }) {
  if (usage.status !== "ok") {
    return (
      <div className="mt-[var(--space-6)] flex items-start gap-[var(--space-2)] text-[length:var(--text-footnote)] text-[var(--text-secondary)]" data-testid="usage-unavailable">
        <AlertTriangle size={14} className="mt-[2px] flex-shrink-0" style={{ color: "var(--system-orange)" }} />
        <span>Usage unavailable: {usage.unavailable?.message ?? "the provider gave no reading."}</span>
      </div>
    )
  }
  const dollars = dollarLine(usage)
  return (
    <section className="mt-[var(--space-6)] min-w-0" data-testid="provider-usage">
      <h3 className="truncate text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--text-primary)]">Reported by the provider</h3>
      <div className="mt-[var(--space-2)] grid gap-[var(--space-3)]">
        {(usage.windows ?? []).map((window) => <WindowRow key={window.name} window={window} now={now} />)}
      </div>
      {dollars && <div className="mt-[var(--space-3)] text-[length:var(--text-footnote)] text-[var(--text-secondary)]" data-testid="usage-dollars">{dollars}</div>}
    </section>
  )
}

/**
 * An opencode card's figures. The provider's reading, when it has one, stands for its provider: the local ledger's
 * buckets for the same provider would sit beside it as a second, contradictory 0%, so they are left out (a bucket of
 * any other provider stays). Without a reading the ledger's estimate stays, named as one.
 */
export function OpencodeUsageBody({ usage, buckets, provider, covered, now }: {
  usage: ProviderUsage | undefined
  buckets: EngineLimitBucket[] | undefined
  /** An account card: its buckets' ids are shown without this provider. */
  provider?: string
  /** The provider the reading is for (an account's own, else the engine's default model's). */
  covered?: string
  now: number
}) {
  if (!usage) return <ModelBuckets buckets={buckets} provider={provider} now={now} />
  const others = usage.status === "ok" ? (buckets ?? []).filter((b) => covered === undefined || !b.id.startsWith(`${covered}/`)) : (buckets ?? [])
  const hasEstimate = others.some((b) => (b.windows?.length ?? 0) + (b.primary ? 1 : 0) > 0)
  return (
    <>
      <ProviderUsagePanel usage={usage} now={now} />
      {hasEstimate && usage.status !== "ok" && (
        <div className="mt-[var(--space-5)] text-[length:var(--text-caption1)] text-[var(--text-tertiary)]" data-testid="local-estimate">
          Local estimate from this gateway's own turns
        </div>
      )}
      {hasEstimate && <ModelBuckets buckets={others} provider={provider} now={now} />}
    </>
  )
}
