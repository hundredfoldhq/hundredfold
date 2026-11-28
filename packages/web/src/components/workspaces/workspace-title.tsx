import { useSyncExternalStore } from "react"
import { X } from "@/components/ui/icon"
import { useWorkspaces } from "@/hooks/use-workspaces"
import { nativeGatewayProfiles } from "@/lib/native-gateway-bootstrap"
import { nativeBridge } from "@/platform/native-bridge"

const noSubscription = () => () => {}
const noSnapshot = () => undefined

/**
 * The name of the workspace the app is on, at the top of the phone's home screen.
 * Which workspace that is must never be a guess, so a name that is not known yet
 * shows nothing rather than a placeholder that could be mistaken for one.
 */
export function WorkspaceTitle() {
  return nativeBridge() ? <NativeWorkspaceTitle /> : <BrowserWorkspaceTitle />
}

function NativeWorkspaceTitle() {
  const profiles = nativeGatewayProfiles()
  const snapshot = useSyncExternalStore(profiles?.subscribe ?? noSubscription, profiles?.snapshot ?? noSnapshot, noSnapshot)
  const name = snapshot?.profiles.find((profile) => profile.id === snapshot.activeId)?.name
  return (
    <>
      <WorkspaceName name={name} />
      {snapshot?.notice ? <Notice message={snapshot.notice} onDismiss={() => profiles?.dismissNotice()} /> : null}
    </>
  )
}

function BrowserWorkspaceTitle() {
  const { data } = useWorkspaces()
  const current = data?.find((workspace) => workspace.current)
  return <WorkspaceName name={current?.displayName || current?.name} />
}

function WorkspaceName({ name }: { name?: string }) {
  if (!name) return null
  return (
    <div data-testid="workspace-title" className="min-w-0 px-1 pb-2">
      <p className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] uppercase tracking-[0.06em] text-[var(--text-tertiary)]">Workspace</p>
      {/* Three lines at most, broken anywhere: a long name stays whole and readable on a narrow screen. */}
      <h1
        title={name}
        className="line-clamp-3 min-w-0 text-[length:var(--text-title3)] font-[var(--weight-semibold)] leading-tight text-[var(--text-primary)] [overflow-wrap:anywhere]"
      >
        {name}
      </h1>
    </div>
  )
}

function Notice({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div
      role="status"
      data-testid="workspace-notice"
      className="mb-2 flex items-start gap-2 rounded-[var(--radius-md)] bg-[var(--fill-tertiary)] px-3 py-2 text-[length:var(--text-footnote)] text-[var(--text-secondary)]"
    >
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{message}</span>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="-mr-1 -mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] active:bg-[var(--fill-secondary)]"
      >
        <X size={14} aria-hidden />
      </button>
    </div>
  )
}
