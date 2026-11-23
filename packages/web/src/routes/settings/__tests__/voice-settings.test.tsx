import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type React from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SettingsPage from '../page'

/**
 * The Voice section: the voice-mode fields only. A config that still carries a
 * retired `realtime` block must load, show nothing for it, and save cleanly.
 */

const apiMocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
  getOrg: vi.fn(),
  sttStatus: vi.fn(),
  sttUpdateConfig: vi.fn(),
  sttDownload: vi.fn(),
}))


vi.mock('@/lib/api', () => ({ api: apiMocks }))
vi.mock('@/components/page-layout', () => ({ PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock('@/routes/providers', () => ({ useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }) }))
vi.mock('@/routes/settings-provider', () => ({
  useSettings: () => ({
    settings: {},
    setAccentColor: vi.fn(),
    setCompanyName: vi.fn(),
    setPortalName: vi.fn(),
    setPortalSubtitle: vi.fn(),
    setOperatorName: vi.fn(),
    setPortalEmoji: vi.fn(),
    setLanguage: vi.fn(),
    resetAll: vi.fn(),
  }),
}))
vi.mock('@/hooks/use-model-registry', () => ({ useModelRegistry: () => ({ data: undefined }) }))
vi.mock('@/hooks/use-onboarding', () => ({ useOnboarding: () => ({ data: undefined }) }))
vi.mock('@/components/ui/emoji-picker', () => ({ EmojiPicker: () => null }))
vi.mock('@/components/auth/remote-access-panel', () => ({ RemoteAccessPanel: () => null }))
vi.mock('@/routes/auth-provider', () => ({
  useAuth: () => ({ authState: {}, devices: [], createPairingCode: vi.fn(), logout: vi.fn(), unpairDevice: vi.fn() }),
}))

const STORED_KEY_SENTINEL = '***'
const STALE_REALTIME = { provider: 'openai', apiKey: STORED_KEY_SENTINEL, model: 'gpt-realtime' }

function renderSettings() {
  render(
    <MemoryRouter>
      <SettingsPage />
    </MemoryRouter>,
  )
}

/** There is no Save button: an edit is what asks for a write. */
function save() {
  fireEvent.click(screen.getByRole('switch', { name: 'Interrupt on new message' }))
}

beforeEach(() => {
  apiMocks.getConfig.mockResolvedValue({ config: { realtime: STALE_REALTIME }, revision: 'rev-1' })
  apiMocks.updateConfig.mockResolvedValue({ revision: 'rev-1' })
  apiMocks.getOrg.mockResolvedValue({ employees: [] })
  apiMocks.sttStatus.mockResolvedValue({ available: false, model: null, downloading: false, progress: 0, languages: ['en'] })
  apiMocks.sttUpdateConfig.mockResolvedValue({})
  apiMocks.sttDownload.mockResolvedValue({})
})

describe('the Voice section', () => {
  it('shows the voice-mode fields and none of the retired realtime or orb fields', async () => {
    renderSettings()

    expect(await screen.findByRole('combobox', { name: 'Spoken reply speed' })).not.toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Voice provider' })).toBeNull()
    expect(screen.queryByLabelText('Voice API key')).toBeNull()
    expect(screen.queryByText('Stored')).toBeNull()
    expect(screen.queryByRole('radiogroup', { name: /orb/i })).toBeNull()
    expect(screen.queryByRole('switch', { name: /talk orb/i })).toBeNull()
    expect(document.body.textContent).not.toMatch(/orb|realtime/i)
  })

  it('saves with a stale realtime block in the file, handing it back untouched', async () => {
    renderSettings()
    await screen.findByRole('combobox', { name: 'Spoken reply speed' })

    save()

    await waitFor(() =>
      expect(apiMocks.updateConfig).toHaveBeenCalledWith(
        expect.objectContaining({ realtime: STALE_REALTIME }),
        'rev-1',
      ),
    )
  })
})

describe('the speaking speed (voice mode)', () => {
  beforeEach(() => apiMocks.updateConfig.mockClear())
  const speedSelect = () => screen.findByRole('combobox', { name: 'Spoken reply speed' }) as Promise<HTMLSelectElement>

  it('offers Slower, Normal, Faster and Fastest, and shows Normal when nothing is set', async () => {
    renderSettings()

    const select = await speedSelect()
    expect(Array.from(select.querySelectorAll('option')).map((o) => o.textContent)).toEqual([
      'Slower (0.8×)',
      'Normal (1×)',
      'Faster (1.25×)',
      'Fastest (1.5×)',
    ])
    expect(select.value).toBe('1')
  })

  it('writes the chosen speed to voice.tts.speed and leaves the rest of the voice block alone', async () => {
    apiMocks.getConfig.mockResolvedValue({
      config: { realtime: STALE_REALTIME, voice: { enabled: true, tts: { voice: 'af_bella' } } },
      revision: 'rev-1',
    })
    renderSettings()

    fireEvent.change(await speedSelect(), { target: { value: '1.5' } })

    await waitFor(() =>
      expect(apiMocks.updateConfig).toHaveBeenCalledWith(
        expect.objectContaining({ voice: { enabled: true, tts: { voice: 'af_bella', speed: 1.5 } } }),
        'rev-1',
      ),
    )
  })

  it('shows a speed from the file that is not a preset as it is, and does not rewrite it by being opened', async () => {
    apiMocks.getConfig.mockResolvedValue({
      config: { realtime: STALE_REALTIME, voice: { enabled: true, tts: { speed: 1.1 } } },
      revision: 'rev-1',
    })
    renderSettings()

    const select = await speedSelect()
    expect(select.value).toBe('1.1')
    expect(Array.from(select.querySelectorAll('option')).map((o) => o.textContent)).toContain('Custom (1.1×)')
    await waitFor(() => expect(apiMocks.getConfig).toHaveBeenCalled())
    expect(apiMocks.updateConfig).not.toHaveBeenCalled()
  })

  it('says so when voice mode is off, and not when it is on', async () => {
    renderSettings()
    await speedSelect()
    expect(screen.queryByText(/Voice mode is off/)).not.toBeNull()
  })

  it('does not say so when voice mode is on', async () => {
    apiMocks.getConfig.mockResolvedValue({
      config: { realtime: STALE_REALTIME, voice: { enabled: true } },
      revision: 'rev-1',
    })
    renderSettings()
    await speedSelect()
    expect(screen.queryByText(/Voice mode is off/)).toBeNull()
  })
})
