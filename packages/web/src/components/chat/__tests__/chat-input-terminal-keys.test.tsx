import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { CliKeybar, CLI_KEYS } from "../cli-keybar"

const orgData = { employees: [] }
const skillsData: unknown[] = []

vi.mock("@/hooks/use-employees", () => ({
  useOrg: () => ({ data: orgData }),
}))

vi.mock("@/hooks/use-skills", () => ({
  useSkills: () => ({ data: skillsData, refetch: vi.fn() }),
}))

import { ChatInput } from "../chat-input"

function renderInput(terminalActionsSlot?: React.ReactNode) {
  return render(
    <ChatInput
      disabled={false}
      loading={false}
      onSend={vi.fn()}
      onNewSession={vi.fn()}
      onStatusRequest={vi.fn()}
      terminalActionsSlot={terminalActionsSlot}
    />,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("ChatInput terminal keys", () => {
  it("renders no shortcuts strip under the composer", () => {
    renderInput()
    expect(screen.queryByText(/shortcuts/i)).toBeNull()
  })

  it("renders no terminal-keys control when the chat view supplies none", () => {
    renderInput()
    expect(screen.queryByRole("button", { name: "Terminal keys" })).toBeNull()
  })

  it("places the terminal-keys control immediately before Send", () => {
    renderInput(<CliKeybar onKey={vi.fn()} />)

    const keybar = screen.getByRole("button", { name: "Terminal keys" })
    const send = screen.getByRole("button", { name: "Send message" })
    // Both live in the composer toolbar; the keybar's wrapper is Send's
    // immediate previous sibling.
    expect(keybar.closest("div")?.parentElement?.nextElementSibling).toBe(send)
  })

  it("opens the terminal-keys popover and sends each key's data", () => {
    const onKey = vi.fn()
    renderInput(<CliKeybar onKey={onKey} />)

    fireEvent.click(screen.getByRole("button", { name: "Terminal keys" }))
    expect(screen.getByRole("toolbar", { name: "Terminal keys" })).toBeTruthy()

    for (const key of CLI_KEYS) {
      fireEvent.click(screen.getByRole("button", { name: key.aria }))
    }
    expect(onKey.mock.calls.map(call => call[0])).toEqual(CLI_KEYS.map(key => key.data))
  })
})
