import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type React from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SettingsPage from '../page'

/** The Voice mode section: the sound cues' on/off and volume, written to the `voice.cues` block. */

const apiMocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
  getOrg: vi.fn(),
}))

vi.mock('@/lib/api', () => ({ api: apiMocks }))
vi.mock('@/components/talk/orb-canvas', () => ({ OrbCanvas: () => <canvas /> }))
vi.mock('@/lib/talk-capability', () => ({ fetchTalkCapability: vi.fn().mockResolvedValue({ configured: false, providers: [], voices: [] }) }))
vi.mock('@/components/page-layout', () => ({ PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock('@/routes/providers', () => ({ useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }) }))
vi.mock('@/routes/settings-provider', () => ({
  useSettings: () => ({
    settings: { talkOrb: false, talkOrbVariant: 'mist', talkOrbIntensity: 'standard' },
    setAccentColor: vi.fn(), setCompanyName: vi.fn(), setPortalName: vi.fn(), setPortalSubtitle: vi.fn(), setOperatorName: vi.fn(),
    setPortalEmoji: vi.fn(), setLanguage: vi.fn(), setTalkOrb: vi.fn(), setTalkOrbVariant: vi.fn(), setTalkOrbIntensity: vi.fn(), resetAll: vi.fn(),
  }),
}))
vi.mock('@/hooks/use-model-registry', () => ({ useModelRegistry: () => ({ data: undefined }) }))
vi.mock('@/hooks/use-onboarding', () => ({ useOnboarding: () => ({ data: undefined }) }))
vi.mock('@/components/ui/emoji-picker', () => ({ EmojiPicker: () => null }))
vi.mock('@/components/auth/remote-access-panel', () => ({ RemoteAccessPanel: () => null }))
vi.mock('@/routes/auth-provider', () => ({
  useAuth: () => ({ authState: {}, devices: [], createPairingCode: vi.fn(), logout: vi.fn(), unpairDevice: vi.fn() }),
}))

function renderSettings() {
  render(
    <MemoryRouter>
      <SettingsPage />
    </MemoryRouter>,
  )
}

function stored(config: Record<string, unknown>) {
  apiMocks.getConfig.mockResolvedValue({ config, revision: 'rev-1' })
}

beforeEach(() => {
  apiMocks.updateConfig.mockReset().mockResolvedValue({ revision: 'rev-2' })
  apiMocks.getOrg.mockResolvedValue({ employees: [] })
})

describe('voice mode sound cues', () => {
  it('shows the defaults when the config has no voice block: on, at 30%', async () => {
    stored({})
    renderSettings()
    const toggle = await screen.findByRole('switch', { name: 'Voice mode sound cues' })
    expect((toggle as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('slider', { name: 'Voice mode cue volume' }) as HTMLInputElement).value).toBe('30')
    expect(screen.getByText('30%')).toBeTruthy()
  })

  it('shows what is stored, and tolerates stale keys', async () => {
    stored({ voice: { enabled: true, cues: { enabled: false, volume: 0.65, retired: 1 } } })
    renderSettings()
    expect(((await screen.findByRole('switch', { name: 'Voice mode sound cues' })) as HTMLInputElement).checked).toBe(false)
    const slider = screen.getByRole('slider', { name: 'Voice mode cue volume' }) as HTMLInputElement
    expect(slider.value).toBe('65')
    expect(slider.disabled).toBe(true)
  })

  it('turning cues off writes only voice.cues.enabled and leaves the rest of the voice block alone', async () => {
    stored({ voice: { enabled: true, mode: 'push-to-talk' } })
    renderSettings()
    fireEvent.click(await screen.findByRole('switch', { name: 'Voice mode sound cues' }))
    await waitFor(() =>
      expect(apiMocks.updateConfig).toHaveBeenCalledWith(
        expect.objectContaining({ voice: { enabled: true, mode: 'push-to-talk', cues: { enabled: false } } }),
        'rev-1',
      ),
    )
  })

  it('the slider writes the volume as a fraction', async () => {
    stored({})
    renderSettings()
    fireEvent.change(await screen.findByRole('slider', { name: 'Voice mode cue volume' }), { target: { value: '55' } })
    await waitFor(() =>
      expect(apiMocks.updateConfig).toHaveBeenCalledWith(expect.objectContaining({ voice: { cues: { volume: 0.55 } } }), 'rev-1'),
    )
  })
})
