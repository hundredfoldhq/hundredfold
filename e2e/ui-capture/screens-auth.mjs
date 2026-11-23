// The sign-in screen and the route failure and loading screens. They sit in their
// own file so screens.mjs stays small; it spreads them into SCREENS.

// Route chunks are all named page-*.js. A route opened directly fetches only its own, so holding or
// refusing the pattern holds or refuses that route.
const CHUNKS = '**/assets/page-*.js'

export const AUTH_SCREENS = [
  {
    // An unpaired browser: the gateway reports that auth is required and this browser has none.
    name: 'sign-in',
    title: 'Sign-in, pair this browser',
    url: () => '/',
    ready: 'Pair This Browser',
    setup: async (page) => {
      await page.route('**/api/auth/state', (route) => route.fulfill({
        json: { authRequired: true, authenticated: false, canBootstrapLocal: false, networkExposed: false },
      }))
    },
  },
  {
    // A route whose chunk cannot be fetched: the router's error element.
    name: 'route-error',
    title: 'Route failure',
    url: () => '/logs',
    ready: 'This page could not load',
    setup: async (page) => { await page.route(CHUNKS, (route) => route.abort()) },
  },
  {
    // A route whose chunk is still on its way: the Suspense fallback.
    name: 'loading',
    title: 'Route loading',
    url: () => '/logs',
    waitUntil: 'load',
    readyLocator: (page) => page.getByRole('status', { name: 'Loading page' }),
    setup: async (page) => { await page.route(CHUNKS, () => {}) },
  },
]
