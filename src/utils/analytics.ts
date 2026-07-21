// Google Analytics 4 integration.
//
// This module is a no-op unless `VITE_GA_MEASUREMENT_ID` is set at build
// time (typical value: `G-XXXXXXXXXX`). That keeps local dev / preview
// builds out of the production analytics property without any flag
// juggling — just don't set the env var.
//
// We intentionally avoid `react-ga4` and friends so the bundle stays lean
// (gtag.js is loaded lazily on demand) and so we can control consent +
// page-view firing for the SPA without fighting a wrapper.

type GtagArgs =
  | ['js', Date]
  | ['config', string, Record<string, unknown>?]
  | ['event', string, Record<string, unknown>?]
  | ['set', Record<string, unknown>]
  | ['consent', 'default' | 'update', Record<string, unknown>]

declare global {
  interface Window {
    dataLayer?: unknown[]
    gtag?: (...args: GtagArgs) => void
  }
}

const MEASUREMENT_ID = (import.meta.env.VITE_GA_MEASUREMENT_ID as string | undefined)?.trim() || ''

// Debug toggle: append `?ga_debug` (or `?ga_debug=0` to clear) to any URL, or
// set `localStorage.LR_GA_DEBUG = '1'` in the console. When on we (a) bypass
// the Do-Not-Track opt-out so the tag still fires during testing, (b) set the
// GA4 `debug_mode` flag so hits surface in DebugView in real time, and (c)
// mirror every gtag call to the console under the `[LR:analytics]` tag. The
// URL form is sticky — it's persisted to localStorage so it survives the SPA's
// query-string scrubbing and subsequent navigations.
function readGaDebug(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const params = new URLSearchParams(window.location.search)
    if (params.has('ga_debug')) {
      const v = params.get('ga_debug')
      const on = v === '' || v === '1' || v === 'true'
      localStorage.setItem('LR_GA_DEBUG', on ? '1' : '0')
      return on
    }
    return localStorage.getItem('LR_GA_DEBUG') === '1'
  } catch {
    return false
  }
}

const GA_DEBUG = readGaDebug()

function dbg(...args: unknown[]): void {
  if (GA_DEBUG) console.debug('[LR:analytics]', ...args)
}

export function sanitizeAnalyticsUrl(value: string, baseUrl?: string): string {
  if (!value) return ''
  try {
    const url = new URL(value, baseUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    return `${url.origin}${url.pathname}`
  } catch {
    return ''
  }
}

function safePageContext(path = window.location.pathname): Record<string, string> {
  const pageUrl = new URL(path, window.location.origin)
  return {
    page_path: pageUrl.pathname,
    page_location: sanitizeAnalyticsUrl(pageUrl.href),
    page_referrer: sanitizeAnalyticsUrl(document.referrer, window.location.origin),
  }
}

let initialized = false

function isEnabled(): boolean {
  if (!MEASUREMENT_ID) return false
  if (typeof window === 'undefined') return false
  // Respect the user's Do-Not-Track preference — opt-out, no UI required. The
  // explicit ga_debug toggle overrides it so developers can verify the
  // pipeline from their own DNT-enabled browsers.
  if (!GA_DEBUG && typeof navigator !== 'undefined' && navigator.doNotTrack === '1') return false
  return true
}

/** One-time init: injects the gtag script + sets sane defaults. Safe to
 *  call repeatedly — additional calls are ignored. */
export function initAnalytics(): void {
  if (initialized) return
  if (!isEnabled()) {
    if (GA_DEBUG) {
      dbg(
        'debug toggle ON but analytics stayed disabled —',
        !MEASUREMENT_ID
          ? 'no VITE_GA_MEASUREMENT_ID set in this build'
          : 'unexpected (check isEnabled)',
      )
    }
    return
  }
  initialized = true

  window.dataLayer = window.dataLayer || []
  // gtag() pushes to dataLayer; the loaded gtag.js reads from there. It MUST
  // push the native `arguments` object — gtag.js inspects each queued item and
  // silently ignores real arrays (e.g. a spread rest param), so commands never
  // dispatch and no hit is ever sent. Verified empirically against a live GA4
  // stream: the array form produces zero /g/collect requests.
  window.gtag = function gtag() {
    // eslint-disable-next-line prefer-rest-params
    window.dataLayer!.push(arguments)
  }

  const s = document.createElement('script')
  s.async = true
  s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(MEASUREMENT_ID)}`
  document.head.appendChild(s)

  window.gtag('js', new Date())
  // We fire page_view manually on React Router navigations (see
  // trackPageView), so disable the auto page_view that gtag fires on
  // config. Otherwise the initial load double-counts.
  window.gtag('config', MEASUREMENT_ID, {
    send_page_view: false,
    anonymize_ip: true,
    ignore_referrer: true,
    ...safePageContext(),
    // debug_mode routes this client's hits into GA4 DebugView so they show
    // up immediately while testing (instead of the 24-48h report lag).
    ...(GA_DEBUG ? { debug_mode: true } : {}),
  })
  dbg('initialized', MEASUREMENT_ID, GA_DEBUG ? '(debug_mode on → see GA4 DebugView)' : '')
}

/** Send a page_view event. Call this on every React Router navigation. */
export function trackPageView(path: string, title?: string): void {
  if (!isEnabled() || !window.gtag) return
  window.gtag('event', 'page_view', {
    page_title: title ?? document.title,
    ...safePageContext(path),
  })
  dbg('page_view', path)
}

/** Send a custom GA4 event. Names must be snake_case and ≤40 chars. */
export function trackEvent(name: string, params?: Record<string, unknown>): void {
  if (!isEnabled() || !window.gtag) return
  // GA4 otherwise derives page_location from the browser URL, which can contain
  // the address query parameter on /map. Override the page context last so
  // callers cannot accidentally reintroduce query strings or hashes.
  window.gtag('event', name, { ...params, ...safePageContext() })
  dbg('event', name, params ?? {})
}
