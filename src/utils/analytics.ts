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

let initialized = false

function isEnabled(): boolean {
  if (!MEASUREMENT_ID) return false
  if (typeof window === 'undefined') return false
  // Respect the user's Do-Not-Track preference — opt-out, no UI required.
  if (typeof navigator !== 'undefined' && navigator.doNotTrack === '1') return false
  return true
}

/** One-time init: injects the gtag script + sets sane defaults. Safe to
 *  call repeatedly — additional calls are ignored. */
export function initAnalytics(): void {
  if (initialized) return
  if (!isEnabled()) return
  initialized = true

  window.dataLayer = window.dataLayer || []
  // gtag() pushes to dataLayer; the loaded script reads from there.
  window.gtag = function gtag(...args) {
    window.dataLayer!.push(args)
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
  })
}

/** Send a page_view event. Call this on every React Router navigation. */
export function trackPageView(path: string, title?: string): void {
  if (!isEnabled() || !window.gtag) return
  window.gtag('event', 'page_view', {
    page_path: path,
    page_title: title ?? document.title,
    page_location: window.location.href,
  })
}

/** Send a custom GA4 event. Names must be snake_case and ≤40 chars. */
export function trackEvent(name: string, params?: Record<string, unknown>): void {
  if (!isEnabled() || !window.gtag) return
  window.gtag('event', name, params)
}
