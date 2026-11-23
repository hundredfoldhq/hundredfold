import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import type { MediaAttachment } from '@/lib/conversations'
import { MediaPreview } from './media-preview'
import { useOrg } from '@/hooks/use-employees'
import { useSkills } from '@/hooks/use-skills'
import { EmployeeAvatar } from '@/components/ui/employee-avatar'
import { composerCardPresentation } from './chat-composer-presentation'
import { useChatDraft } from './use-chat-draft'
import { isCoarsePointer } from '@/lib/terminal-input'
import { deliveryForSend, readSendDelivery, writeSendDelivery, type SendDelivery } from './send-delivery'

interface Employee {
  name: string
  displayName?: string
  department?: string
  rank?: string
  engine?: string
}

interface SlashCommand {
  name: string
  description: string
  /** Whether this command needs an @employee argument */
  needsEmployee?: boolean
}

/** Built-in commands offered in the slash menu. `/new` and `/status` are handled
 *  client-side (see resolveClientCommand); `/compact` is sent like a message and
 *  the gateway routes it to the session engine's own compaction. */
export const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: 'new', description: 'Start a new chat session' },
  { name: 'status', description: 'Show current session info' },
  { name: 'compact', description: "Compact this chat's context (Claude Code, opencode). On Claude, add focus: /compact keep the Todo ids" },
]

export type ClientCommand = 'new' | 'status'

export function resolveClientCommand(text: string): ClientCommand | null {
  const trimmed = text.trim()
  if (trimmed === '/new') return 'new'
  if (trimmed === '/status') return 'status'
  return null
}

interface ChatInputProps {
  /** Existing chat owned by this composer. Null is the new-chat composer. */
  sessionId?: string | null
  /** Only the focused pane may receive global composer commands or autofocus. */
  isActive?: boolean
  disabled: boolean
  loading: boolean
  onSend: (message: string, media?: MediaAttachment[], interrupt?: boolean) => boolean | void | Promise<boolean | void>
  onInterrupt?: () => void
  onNewSession: () => void
  onStatusRequest: () => void
  /** Incremented when skills change on the gateway, triggers re-fetch */
  skillsVersion?: number
  /** Files dropped onto the chat area (from parent drag & drop) */
  droppedFiles?: File[]
  /** Called after droppedFiles have been consumed as pending attachments */
  onDroppedFilesConsumed?: () => void
  /** Incrementing counter that triggers textarea focus when changed */
  focusTrigger?: number
  /** Optional Engine/Model/Effort selector row, rendered just above the input. */
  selectorSlot?: React.ReactNode
  /** Optional ambient status (e.g. background-activity StateLine), rendered in
   *  the toolbar's flexible middle so it never shifts layout. */
  statusSlot?: React.ReactNode
  /** Optional terminal-key control, rendered in the toolbar beside Send. */
  terminalActionsSlot?: React.ReactNode
  /** Optional per-session status items (context meter), right after the model chip. */
  sessionStatusSlot?: React.ReactNode
  /** Voice-mode control, beside Send. Absent unless the gateway has voice on. */
  voiceSlot?: React.ReactNode
}

/* ── File to MediaAttachment ─────────────────────────────── */

/**
 * Minimum widths that keep the model chip's icons (48px) and the waiting-on status (24px for the
 * dot and count, 40px, then 72px for the short label) visible in a narrow composer. A floor only
 * applies once the composer row has room for it. The parts of the row that never shrink (attach,
 * context ring, Send and the gaps) take 146px with phone-sized buttons and 148px on desktop, so
 * each threshold is 148px + the floors that would apply + 2px of slack: a busy row of any width
 * never overflows and never pushes Send out. Sized from the composer container, never the
 * viewport, because a chat-grid pane is phone-narrow on a wide screen. A row that also shows the
 * CLI keys or the voice control has less to spare, so it gets no floors (TOOLBAR_FLOORS is only
 * applied when `toolbarFloors` holds).
 */
const TOOLBAR_FLOORS = {
  selector: '@min-[198px]/composer:min-w-12',
  status: '@min-[222px]/composer:has-[>*]:min-w-6 @min-[238px]/composer:has-[>*]:min-w-10 @min-[270px]/composer:has-[>*]:min-w-[4.5rem]',
} as const

function resizeImage(file: File, maxPx: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      let { width, height } = img
      if (width > maxPx || height > maxPx) {
        const scale = maxPx / Math.max(width, height)
        width = Math.round(width * scale)
        height = Math.round(height * scale)
      }
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) { reject(new Error('no canvas context')); return }
      ctx.drawImage(img, 0, 0, width, height)
      const mimeType = file.size > 50000 ? 'image/jpeg' : 'image/png'
      const quality = mimeType === 'image/jpeg' ? 0.85 : undefined
      resolve(canvas.toDataURL(mimeType, quality))
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image load failed')) }
    img.src = url
  })
}

async function fileToAttachment(file: File): Promise<MediaAttachment> {
  const isImage = file.type.startsWith('image/')
  const isAudio = file.type.startsWith('audio/')
  const isVideo = file.type.startsWith('video/')

  let dataUrl: string
  if (isImage) {
    dataUrl = await resizeImage(file, 1200)
  } else {
    dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onloadend = () => resolve(reader.result as string)
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }

  return {
    type: isImage ? 'image' : isAudio ? 'audio' : isVideo ? 'video' : 'file',
    url: dataUrl,
    name: file.name,
    mimeType: file.type,
    size: file.size,
    file,
  }
}

/* ── Component ──────────────────────────────────────────── */

export function ChatInput({
  sessionId = null,
  isActive = true,
  disabled,
  loading,
  onSend,
  onInterrupt,
  onNewSession,
  onStatusRequest,
  skillsVersion,
  droppedFiles,
  onDroppedFilesConsumed,
  focusTrigger,
  selectorSlot,
  statusSlot,
  terminalActionsSlot,
  sessionStatusSlot,
  voiceSlot,
}: ChatInputProps) {
  const { value, setValue, pendingSend } = useChatDraft(sessionId)
  const [employees, setEmployees] = useState<Employee[]>([])
  const [showMentions, setShowMentions] = useState(false)
  const [mentionFilter, setMentionFilter] = useState('')
  const [mentionIndex, setMentionIndex] = useState(0)
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>(BUILTIN_COMMANDS)
  const [showCommands, setShowCommands] = useState(false)
  const [commandFilter, setCommandFilter] = useState('')
  const [commandIndex, setCommandIndex] = useState(0)
  const [pendingAttachments, setPendingAttachments] = useState<MediaAttachment[]>([])
  // While a turn runs, a sent message either waits for it or cuts it off.
  // The standing choice is remembered; Alt+Enter flips it for one send.
  const [sendDelivery, setSendDelivery] = useState<SendDelivery>(() => readSendDelivery(typeof localStorage === 'undefined' ? null : localStorage))
  useEffect(() => { writeSendDelivery(typeof localStorage === 'undefined' ? null : localStorage, sendDelivery) }, [sendDelivery])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // An input that mounts in a pane that is not active (a split remounts its panes) finds a request
  // already raised for the input before it: that one is spent, and must not fire when the pane is
  // next activated, which a click on one of its tabs does.
  const handledFocusTriggerRef = useRef(isActive ? 0 : focusTrigger ?? 0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const rafRef = useRef<number | null>(null)
  const previousSkillsVersionRef = useRef(skillsVersion)
  const { data: orgData } = useOrg()
  const { data: skillsData, refetch: refetchSkills } = useSkills()

  // Live mirrors so async handlers read the latest value without re-creating
  // themselves (and without stale-closure races on send).
  const valueRef = useRef('')
  const pendingAttachmentsRef = useRef<MediaAttachment[]>([])
  const submittingRef = useRef(false)
  const disabledRef = useRef(disabled)
  const sendTextRef = useRef<(rawText: string, media: MediaAttachment[]) => Promise<boolean>>(async () => false)
  pendingAttachmentsRef.current = pendingAttachments
  valueRef.current = value
  disabledRef.current = disabled

  const resize = useCallback((el: HTMLTextAreaElement) => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      el.style.height = 'auto'
      el.style.height = Math.min(el.scrollHeight, 180) + 'px'
    })
  }, [])

  useEffect(() => {
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  // Focus after session switches once the remounted textarea is ready.
  // Skip mobile so switching sessions does not pop the on-screen keyboard.
  // Each trigger is handled once so reactivating a pane leaves shortcuts available.
  useEffect(() => {
    if (!isActive || !focusTrigger || focusTrigger <= handledFocusTriggerRef.current) return
    handledFocusTriggerRef.current = focusTrigger
    if (window.innerWidth < 768) return
    const raf = requestAnimationFrame(() => textareaRef.current?.focus())
    return () => cancelAnimationFrame(raf)
  }, [focusTrigger, isActive])
  const mentionItemRefs = useRef<Map<number, HTMLButtonElement>>(new Map())

  // Floors assume the toolbar's fixed parts; extra fixed controls leave no room to spare.
  const toolbarFloors = !terminalActionsSlot && !voiceSlot

  // Consume files dropped onto the chat area by the parent
  const consumedRef = useRef<File[] | undefined>(undefined)
  useEffect(() => {
    if (!droppedFiles || droppedFiles.length === 0) return
    // Guard against React Strict Mode double-firing the effect
    if (consumedRef.current === droppedFiles) return
    consumedRef.current = droppedFiles
    ;(async () => {
      const newAttachments: MediaAttachment[] = []
      for (const file of droppedFiles) {
        newAttachments.push(await fileToAttachment(file))
      }
      setPendingAttachments((prev) => [...prev, ...newAttachments])
      onDroppedFilesConsumed?.()
    })()
  }, [droppedFiles, onDroppedFilesConsumed])

  // Load employees for @mention (with full details)
  useEffect(() => {
    if (!Array.isArray(orgData?.employees)) return
    setEmployees(orgData.employees.map((emp) => ({
      name: emp.name,
      displayName: emp.displayName,
      department: emp.department,
      rank: emp.rank,
      engine: emp.engine,
    })))
  }, [orgData])

  // Load skills as slash commands.
  useEffect(() => {
    if (!Array.isArray(skillsData)) return
    const skillCommands: SlashCommand[] = skillsData
      .filter((s) => !BUILTIN_COMMANDS.some((b) => b.name === s.name))
      .map((s) => ({
        name: s.name as string,
        description: (s.description as string) || '',
        needsEmployee: s.name === 'sync',
      }))
    setSlashCommands([...BUILTIN_COMMANDS, ...skillCommands])
  }, [skillsData])

  useEffect(() => {
    if (previousSkillsVersionRef.current === skillsVersion) return
    previousSkillsVersionRef.current = skillsVersion
    void refetchSkills()
  }, [skillsVersion, refetchSkills])


  const handleMentionSelect = useCallback(
    (name: string) => {
      const atIdx = value.lastIndexOf('@')
      if (atIdx !== -1) {
        const before = value.slice(0, atIdx)
        setValue(before + '@' + name + ' ')
      }
      setShowMentions(false)
      textareaRef.current?.focus()
    },
    [value]
  )

  const handleCommandSelect = useCallback(
    (cmd: SlashCommand) => {
      if (cmd.needsEmployee) {
        // Insert command + @ to trigger mention autocomplete
        setValue('/' + cmd.name + ' @')
        setShowCommands(false)
        // Trigger mention dropdown
        setMentionFilter('')
        setMentionIndex(0)
        setShowMentions(true)
      } else {
        setValue('/' + cmd.name)
        setShowCommands(false)
      }
      textareaRef.current?.focus()
    },
    []
  )

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const val = e.target.value
    setValue(val)

    // Detect slash commands: text starts with / and has no space yet (still typing the command name)
    if (val.startsWith('/') && !val.includes(' ')) {
      const filter = val.slice(1).toLowerCase()
      setCommandFilter(filter)
      setCommandIndex(0)
      setShowCommands(true)
      setShowMentions(false)
      return
    }
    setShowCommands(false)

    // Detect @mentions
    const atIdx = val.lastIndexOf('@')
    if (atIdx !== -1) {
      const afterAt = val.slice(atIdx + 1)
      if (!afterAt.includes(' ') && !afterAt.includes('\n')) {
        setMentionFilter(afterAt.toLowerCase())
        setMentionIndex(0)
        setShowMentions(true)
        return
      }
    }
    setShowMentions(false)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Command autocomplete navigation
    if (showCommands && filteredCommands.length > 0) {
      const max = filteredCommands.length
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setCommandIndex((prev) => (prev + 1) % max)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setCommandIndex((prev) => (prev - 1 + max) % max)
        return
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault()
        handleCommandSelect(filteredCommands[commandIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setShowCommands(false)
        return
      }
    }

    // Mention autocomplete navigation
    if (showMentions && filteredEmployees.length > 0) {
      const max = Math.min(filteredEmployees.length, 8)
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionIndex((prev) => (prev + 1) % max)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionIndex((prev) => (prev - 1 + max) % max)
        return
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault()
        handleMentionSelect(filteredEmployees[mentionIndex].name)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setShowMentions(false)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      // Enter that confirms an IME composition belongs to the IME (keyCode 229
      // covers browsers that clear isComposing before keydown fires).
      if (e.nativeEvent.isComposing || e.keyCode === 229) return
      // Soft keyboards have no Shift+Enter: the return key writes a newline and
      // the Send button is the only way to send. Checked per keypress so a
      // keyboard docked to a tablet is honoured as soon as the pointer changes.
      if (isCoarsePointer()) return
      e.preventDefault()
      handleSubmit(e.altKey)
    }
  }

  // Send core — resolves client-only commands, otherwise keeps the draft until
  // onSend acknowledges it. Shared by the Enter/tap path (handleSubmit) and the
  // composer-control path (Talk drafting and sending).
  async function sendText(rawText: string, media: MediaAttachment[], delivery: SendDelivery = sendDelivery): Promise<boolean> {
    const trimmed = rawText.trim()
    const hasMedia = media.length > 0

    if ((!trimmed && !hasMedia) || disabledRef.current || submittingRef.current) return false
    submittingRef.current = true

    const command = resolveClientCommand(trimmed)
    if (command === 'new') {
      valueRef.current = ''
      setValue('')
      onNewSession()
      submittingRef.current = false
      return true
    }
    if (command === 'status') {
      valueRef.current = ''
      setValue('')
      onStatusRequest()
      submittingRef.current = false
      return true
    }
    const mediaToSend = hasMedia ? [...media] : undefined
    const acknowledgeDraft = pendingSend()
    setShowMentions(false)
    setShowCommands(false)
    try {
      const sending = onSend(trimmed, mediaToSend, delivery === 'now')
      const accepted = typeof sending === 'boolean' ? sending : sending ? (await sending) !== false : true
      if (!accepted) return false
      acknowledgeDraft()
      if (valueRef.current === rawText) {
        valueRef.current = ''
        if (textareaRef.current) textareaRef.current.style.height = 'auto'
      }
      pendingAttachmentsRef.current = pendingAttachmentsRef.current.filter(attachment => !media.includes(attachment))
      setPendingAttachments(current => current.filter(attachment => !media.includes(attachment)))
      return true
    } catch {
      return false
    } finally {
      submittingRef.current = false
    }
  }
  sendTextRef.current = sendText

  function handleSubmit(flipDelivery = false) {
    void sendText(value, pendingAttachments, deliveryForSend(sendDelivery, flipDelivery))
  }

  async function handleFileAttach(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files
    if (!files || files.length === 0) return

    const newAttachments: MediaAttachment[] = []
    for (let i = 0; i < files.length; i++) {
      newAttachments.push(await fileToAttachment(files[i]))
    }
    setPendingAttachments((prev) => [...prev, ...newAttachments])
    e.target.value = ''
  }

  function removePendingAttachment(index: number) {
    setPendingAttachments((prev) => prev.filter((_, i) => i !== index))
  }

  async function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items
    if (!items) return

    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        e.preventDefault()
        const file = items[i].getAsFile()
        if (file) {
          const att = await fileToAttachment(file)
          setPendingAttachments((prev) => [...prev, att])
        }
        return
      }
    }
  }

  // Auto-resize textarea when value changes programmatically (e.g., a Talk draft)
  useEffect(() => {
    if (textareaRef.current) {
      resize(textareaRef.current)
    }
  }, [value, resize])

  const filteredCommands = useMemo(
    () => slashCommands.filter((c) => c.name?.toLowerCase().startsWith(commandFilter)),
    [slashCommands, commandFilter]
  )

  const filteredEmployees = useMemo(
    () => employees.filter((e) => e.name?.toLowerCase().includes(mentionFilter)),
    [employees, mentionFilter]
  )

  const hasContent = value.trim().length > 0 || pendingAttachments.length > 0

  return (
    <div data-chat-composer className="pt-[var(--space-3)] pb-[max(var(--keyboard-inset),var(--safe-bottom),var(--space-3))] bg-[var(--bg)] shrink-0 relative">
      {/* Soft top scrim — fades scrolling content into the composer instead of a
          hard 1px divider. Borderless, readable over the thread in both themes.
          Stays full-bleed (spans the whole thread width). */}
      <div aria-hidden data-chat-composer-fade className="pointer-events-none absolute -top-5 left-0 right-0 h-5 bg-gradient-to-b from-transparent to-[var(--bg)]" />
      {/* Centered measure — caps the composer to the same column as the message
          text (--chat-measure + the message rows' space-3/space-8 side insets), so
          the card lines up edge-for-edge with the thread content instead of
          spanning the full pane. Mobile stays effectively full-width. */}
      <div data-chat-composer-measure className="relative mx-auto w-full max-w-[var(--chat-measure)] px-3 lg:px-8">
      {/* Slash command autocomplete */}
      {showCommands && filteredCommands.length > 0 && (
        <div className="absolute bottom-full left-3 right-3 lg:left-8 lg:right-8 mb-1 border-0 bg-[var(--bg-tertiary)] rounded-[var(--radius-lg)] shadow-[var(--shadow-overlay)] max-h-60 overflow-y-auto z-10">
          {filteredCommands.map((cmd, idx) => {
            const isHighlighted = idx === commandIndex
            return (
              <button
                key={cmd.name}
                ref={(el) => {
                  if (isHighlighted && el) el.scrollIntoView({ block: 'nearest' })
                }}
                onClick={() => handleCommandSelect(cmd)}
                className={`w-full text-left py-[var(--space-2)] px-[var(--space-3)] text-[length:var(--text-footnote)] ${isHighlighted ? 'bg-[var(--fill-secondary)]' : 'bg-transparent'} border-none cursor-pointer flex items-center gap-[var(--space-2)] text-[var(--text-primary)]`}
              >
                <span className="font-[family-name:var(--font-mono)] font-[var(--weight-semibold)] text-[var(--accent)] text-[length:var(--text-footnote)]">/{cmd.name}</span>
                <span className="text-[var(--text-tertiary)] text-[length:var(--text-caption1)]">{cmd.description}</span>
              </button>
            )
          })}
        </div>
      )}

      {/* Mention autocomplete */}
      {showMentions && filteredEmployees.length > 0 && (
        <div className="absolute bottom-full left-3 right-3 lg:left-8 lg:right-8 mb-1 border-0 bg-[var(--bg-tertiary)] rounded-[var(--radius-lg)] shadow-[var(--shadow-overlay)] max-h-40 overflow-y-auto z-10">
          {filteredEmployees.slice(0, 8).map((emp, idx) => {
            const isHighlighted = idx === mentionIndex
            return (
              <button
                key={emp.name}
                ref={(el) => {
                  if (el) mentionItemRefs.current.set(idx, el)
                  else mentionItemRefs.current.delete(idx)
                  if (isHighlighted && el) el.scrollIntoView({ block: 'nearest' })
                }}
                onClick={() => handleMentionSelect(emp.name)}
                className={`w-full text-left py-[var(--space-2)] px-[var(--space-3)] text-[length:var(--text-footnote)] ${isHighlighted ? 'bg-[var(--fill-secondary)]' : 'bg-transparent'} border-none cursor-pointer flex items-center gap-[var(--space-2)] text-[var(--text-primary)]`}
              >
                <EmployeeAvatar name={emp.name} size={20} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-[var(--space-2)]">
                    <span className="font-[var(--weight-semibold)]">{emp.displayName || emp.name}</span>
                    <span className="font-[family-name:var(--font-mono)] text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">@{emp.name}</span>
                  </div>
                  {emp.department && (
                    <div className="text-[length:var(--text-caption2)] text-[var(--text-quaternary)] flex gap-[var(--space-2)] mt-px">
                      <span>{emp.department}</span>
                      {emp.engine && (
                        <span className="text-[var(--accent)] font-[var(--weight-medium)]">{emp.engine}</span>
                      )}
                    </div>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      )}

      {/* Pending attachments preview */}
      {pendingAttachments.length > 0 && (
        <div className="mb-[var(--space-2)]">
          <MediaPreview
            attachments={pendingAttachments}
            onRemove={removePendingAttachment}
          />
        </div>
      )}

      {/* Composer card — borderless: soft fill + shadow do the separating, no
          hairline at rest. A low-opacity accent ring (not a 1px border) marks
          the streaming state. */}
      <div
        {...composerCardPresentation(isActive, loading)}
        onPointerDown={(e) => {
          // Click-to-focus: tapping anywhere in the card (including the gaps
          // between toolbar buttons) lands the caret in the textarea. Real
          // controls stopPropagation so this never fires for them.
          if (disabled) return
          e.preventDefault() // don't steal/blur an existing selection
          textareaRef.current?.focus()
        }}
      >
        {/* Delivery choice — only meaningful while a turn is running: queue
            waits for it, send-now cuts it off. Remembered across sessions. */}
        {loading && (
          <div className="flex items-center gap-[var(--space-2)] px-1 pb-[var(--space-2)]" role="group" aria-label="Delivery for the next message">
            <span className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">Next message:</span>
            {(['queue', 'now'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={sendDelivery === mode}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => setSendDelivery(mode)}
                className={`h-7 shrink-0 cursor-pointer rounded-full border-none px-[var(--space-3)] text-[length:var(--text-caption1)] transition-colors ${sendDelivery === mode ? 'bg-[var(--accent)] text-[var(--accent-contrast)]' : 'bg-[var(--fill-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--fill-secondary)]'}`}
              >
                {mode === 'queue' ? 'Queue' : 'Send now'}
              </button>
            ))}
            <span className="hidden text-[length:var(--text-caption2)] text-[var(--text-quaternary)] sm:inline">Alt+Enter flips</span>
          </div>
        )}
        {/* Textarea */}
        <textarea
          id={isActive ? 'chat-textarea' : undefined}
          data-chat-textarea
          data-chat-session={sessionId ?? 'new'}
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onPointerDown={(e) => e.stopPropagation()}
          placeholder={
            disabled ? 'Waiting for response...'
              : loading ? (sendDelivery === 'now' ? 'Send now, interrupting the reply...' : 'Queue another message...')
                : 'Type a message...'
          }
          rows={1}
          disabled={disabled}
          className={`block w-full bg-transparent border-none outline-none resize-none overflow-y-auto text-[var(--text-primary)] text-[length:var(--text-subheadline)] leading-6 min-h-6 px-1 pt-1 pb-2 m-0 ${disabled ? 'opacity-50' : 'opacity-100'}`}
          onInput={(e) => {
            resize(e.target as HTMLTextAreaElement)
          }}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,audio/*,video/*,.pdf,.doc,.docx,.txt,.csv,.json,.zip"
          multiple
          className="hidden"
          onChange={handleFileAttach}
        />

        {/* Toolbar: [+ attach] · [model chip] · spacer · [terminal keys] · [voice mode] · [send]. A container, so the chip degrades against THIS composer's width — a pane in a 3-column grid is narrow while the viewport is not. */}
        <div className="@container/composer flex items-center gap-[var(--space-2)]">
          {/* Attach */}
          <button
            aria-label="Attach file"
            title="Attach file"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => fileInputRef.current?.click()}
            className="w-[40px] h-[40px] md:w-[36px] md:h-[36px] shrink-0 rounded-full flex items-center justify-center bg-transparent border-none cursor-pointer text-[var(--text-secondary)] hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)] transition-colors"
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>

          {/* Model chip — wrapped so clicks on the trigger (and its inline popover)
              don't re-trigger card focus. The cap bounds a long model label, and
              the wrapper still shrinks when the cap is more than the row has left,
              so nothing in the slot can push Send outside a narrow pane. Where
              the row has room for it, it keeps at least its icons (model,
              fallback): see TOOLBAR_FLOORS. */}
          {selectorSlot && (
            <div
              className={`flex min-w-0 max-w-[55%] shrink items-center overflow-hidden ${toolbarFloors ? TOOLBAR_FLOORS.selector : ''}`}
              onPointerDown={(e) => e.stopPropagation()}
            >
              {selectorSlot}
            </div>
          )}

          {/* display: contents, so the wrapper has no box of its own (the slot's
              own root collapses when it has nothing to show, and no gap is left);
              React's pointer events still bubble through it. */}
          {sessionStatusSlot && (
            <div className="contents" onPointerDown={(e) => e.stopPropagation()}>
              {sessionStatusSlot}
            </div>
          )}

          {/* Ambient status sits left-anchored in the toolbar's flexible middle,
              reading as a continuation of the model chip's cluster rather than a
              floating center element. flex-1 (basis-0) claims only LEFTOVER
              space, and an overlong status clips inside this container. While it
              shows something it keeps a floor where the row has room for one:
              see TOOLBAR_FLOORS. */}
          <div className={`flex min-w-0 flex-1 items-center justify-start overflow-hidden pl-1 ${toolbarFloors ? TOOLBAR_FLOORS.status : ''}`}>
            {statusSlot}
          </div>

          {/* Terminal keys — only in the CLI view, where they have something to
              send. Sits with the other composer controls. */}
          {terminalActionsSlot && (
            <div className="shrink-0" onPointerDown={(e) => e.stopPropagation()}>
              {terminalActionsSlot}
            </div>
          )}

          {/* Voice mode — a spoken conversation with the session. Sits before
              Send; absent (no box, no gap) unless voice is on. */}
          {voiceSlot}

          {/* Send ↔ Stop — one persistent circular button with three states:
                • stop  — a turn is streaming + interruptible (red square)
                • ready — the field has content (solid accent arrow)
                • idle  — empty field (muted, inert)
              Background + arrow/stop crossfade keyed on the mode. */}
          {(() => {
            const showStop = loading && !!onInterrupt
            const mode: 'stop' | 'ready' | 'idle' =
              showStop ? 'stop'
              : hasContent ? 'ready'
              : 'idle'
            // Disabled only when there's genuinely nothing to do: an empty idle
            // field, or the parent is blocking sends (waiting for a response) and
            // we're not in stop mode.
            const isDisabled =
              mode === 'idle' ? true
              : mode === 'stop' ? false
              : disabled
            const label = mode === 'stop' ? 'Stop' : 'Send message'
            return (
              <button
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => {
                  if (showStop) onInterrupt?.()
                  else if (hasContent) handleSubmit()
                  // empty field → nothing to do
                }}
                disabled={isDisabled}
                aria-label={label}
                title={label}
                className={`relative w-[40px] h-[40px] md:w-[38px] md:h-[38px] rounded-full border-none flex items-center justify-center shrink-0 transition-[background-color,color,opacity] duration-200 ease-in-out ${
                  mode === 'stop'
                    ? 'bg-[var(--system-red)] text-white cursor-pointer'
                    : mode === 'ready'
                      ? 'bg-[var(--accent)] text-[var(--accent-contrast)] cursor-pointer'
                      : 'bg-[var(--fill-tertiary)] text-[var(--text-quaternary)] cursor-default'
                }`}
              >
                {/* Send arrow */}
                <span className={`absolute inset-0 flex items-center justify-center transition-all duration-200 ease-in-out ${mode === 'stop' ? 'opacity-0 scale-50' : 'opacity-100 scale-100'}`}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="19" x2="12" y2="5" />
                    <polyline points="5 12 12 5 19 12" />
                  </svg>
                </span>
                {/* Stop square */}
                <span className={`absolute inset-0 flex items-center justify-center transition-all duration-200 ease-in-out ${mode === 'stop' ? 'opacity-100 scale-100' : 'opacity-0 scale-50'}`}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="4" y="4" width="16" height="16" rx="2" />
                  </svg>
                </span>
              </button>
            )
          })()}
        </div>
      </div>
      </div>{/* /centered measure wrapper */}

      <style>{`
        /* Idle base shadow + soft accent ring when the composer holds focus.
           Not a 1px border — a 4px --accent-fill wash. Overridden inline while
           streaming so the brighter loading ring takes precedence. */
        .composer-card-active { box-shadow: var(--shadow-card); }
        .composer-card-active:focus-within { box-shadow: var(--shadow-card), 0 0 0 4px var(--accent-fill); }
        .composer-card-active.composer-card-loading,
        .composer-card-active.composer-card-loading:focus-within { box-shadow: var(--shadow-card), 0 0 0 1.5px color-mix(in srgb, var(--accent) 38%, transparent); }
      `}</style>
    </div>
  )
}
