import { useEffect, useState, useCallback, useRef } from 'react'
import './GuidedTour.css'

interface TourStep {
  selector: string
  title: string
  content: string
  position?: 'top' | 'bottom' | 'left' | 'right'
  beforeShow?: () => void
  afterHide?: () => void
}

interface GuidedTourProps {
  steps: TourStep[]
  storageKey?: string
  forceShow?: boolean
  onComplete?: () => void
  delay?: number
}

export default function GuidedTour({ steps, storageKey = 'lr_tour_done', forceShow = false, onComplete, delay = 1500 }: GuidedTourProps) {
  const [active, setActive] = useState(false)
  const [step, setStep] = useState(0)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const [viewport, setViewport] = useState({ w: typeof window !== 'undefined' ? window.innerWidth : 1024, h: typeof window !== 'undefined' ? window.innerHeight : 768 })
  const tooltipRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const timer = setTimeout(() => {
      if (forceShow || localStorage.getItem(storageKey) !== '1') setActive(true)
    }, delay)
    return () => clearTimeout(timer)
  }, [storageKey, delay, forceShow])

  const measureTarget = useCallback(() => {
    if (!active || step >= steps.length) return
    setViewport({ w: window.innerWidth, h: window.innerHeight })
    const el = document.querySelector(steps[step].selector) as HTMLElement | null
    if (el) {
      const r = el.getBoundingClientRect()
      // If the target is entirely off-screen (e.g. a panel that hasn't
      // slid in yet), don't pin a highlight to an invisible location.
      const onScreen = r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth
      setRect(onScreen ? r : null)
      // scrollIntoView is a no-op for fixed elements but harmless otherwise.
      if (onScreen) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    } else {
      setRect(null)
    }
  }, [active, step, steps])

  useEffect(() => {
    if (!active) return
    steps[step]?.beforeShow?.()
    // Measure immediately for steps that don't need panel transitions, then
    // again after the longest reasonable transition (panel slide-in ~280ms)
    // so panel-targeted steps land on the final on-screen rect.
    measureTarget()
    const t1 = setTimeout(measureTarget, 120)
    const t2 = setTimeout(measureTarget, 380)
    window.addEventListener('resize', measureTarget)
    window.addEventListener('orientationchange', measureTarget)
    return () => {
      clearTimeout(t1)
      clearTimeout(t2)
      window.removeEventListener('resize', measureTarget)
      window.removeEventListener('orientationchange', measureTarget)
    }
  }, [active, step, measureTarget, steps])

  const finish = useCallback(() => {
    steps[step]?.afterHide?.()
    localStorage.setItem(storageKey, '1')
    setActive(false)
    setStep(0)
    setRect(null)
    onComplete?.()
  }, [step, steps, storageKey, onComplete])

  const next = useCallback(() => {
    steps[step]?.afterHide?.()
    if (step + 1 >= steps.length) {
      finish()
    } else {
      setStep(step + 1)
    }
  }, [step, steps, finish])

  const prev = useCallback(() => {
    steps[step]?.afterHide?.()
    setStep(Math.max(0, step - 1))
  }, [step, steps])

  if (!active || step >= steps.length) return null

  const pad = 8
  const current = steps[step]
  const isMobile = viewport.w <= 768
  const margin = 16
  const tooltipW = Math.min(320, viewport.w - margin * 2)
  const tooltipApproxH = 180

  let tooltipStyle: React.CSSProperties = { width: tooltipW }
  if (rect) {
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    const spaceRight = viewport.w - rect.right
    const spaceLeft = rect.left
    const spaceBottom = viewport.h - rect.bottom
    const spaceTop = rect.top

    // On mobile, never use left/right — there's never room for a side tooltip
    // next to a panel that spans the full width.
    let pos: 'top' | 'bottom' | 'left' | 'right' = current.position || 'bottom'
    if (isMobile && (pos === 'left' || pos === 'right')) pos = 'bottom'
    if (pos === 'left' && spaceLeft < tooltipW + 30) pos = spaceRight > tooltipW + 30 ? 'right' : 'bottom'
    if (pos === 'right' && spaceRight < tooltipW + 30) pos = spaceLeft > tooltipW + 30 ? 'left' : 'bottom'
    if (pos === 'bottom' && spaceBottom < tooltipApproxH + margin) pos = spaceTop > tooltipApproxH + margin ? 'top' : 'bottom'
    if (pos === 'top' && spaceTop < tooltipApproxH + margin) pos = spaceBottom > tooltipApproxH + margin ? 'bottom' : 'top'

    const clampX = (x: number) => Math.max(margin, Math.min(x, viewport.w - tooltipW - margin))
    switch (pos) {
      case 'bottom': {
        const top = Math.min(rect.bottom + pad + 8, viewport.h - tooltipApproxH - margin)
        tooltipStyle = { width: tooltipW, top, left: clampX(cx - tooltipW / 2) }
        break
      }
      case 'top': {
        const bottom = Math.min(viewport.h - rect.top + pad + 8, viewport.h - tooltipApproxH - margin)
        tooltipStyle = { width: tooltipW, bottom, left: clampX(cx - tooltipW / 2) }
        break
      }
      case 'left':
        tooltipStyle = { width: tooltipW, top: Math.max(margin, Math.min(cy - 60, viewport.h - tooltipApproxH - margin)), right: viewport.w - rect.left + pad + 8 }
        break
      case 'right':
        tooltipStyle = { width: tooltipW, top: Math.max(margin, Math.min(cy - 60, viewport.h - tooltipApproxH - margin)), left: rect.right + pad + 8 }
        break
    }
  } else {
    // No measurable target — dock the tooltip at the bottom-center of the
    // viewport on mobile (clearer than a center-screen modal that hides the
    // panel underneath) and center on desktop.
    tooltipStyle = isMobile
      ? { width: tooltipW, bottom: margin + 16, left: Math.max(margin, (viewport.w - tooltipW) / 2) }
      : { width: tooltipW, top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }
  }

  return (
    <div className="tour-overlay">
      <svg className="tour-backdrop" width="100%" height="100%">
        <defs>
          <mask id="tour-mask">
            <rect width="100%" height="100%" fill="white" />
            {rect && (
              <rect
                x={rect.left - pad}
                y={rect.top - pad}
                width={rect.width + pad * 2}
                height={rect.height + pad * 2}
                rx={8}
                fill="black"
              />
            )}
          </mask>
        </defs>
        <rect width="100%" height="100%" fill="rgba(0,0,0,0.55)" mask="url(#tour-mask)" />
      </svg>

      {rect && (
        <div
          className="tour-highlight"
          style={{
            top: rect.top - pad,
            left: rect.left - pad,
            width: rect.width + pad * 2,
            height: rect.height + pad * 2,
          }}
        />
      )}

      <div className="tour-tooltip" ref={tooltipRef} style={tooltipStyle}>
        <div className="tour-tooltip-header">
          <strong>{current.title}</strong>
          <span className="tour-step-count">{step + 1} / {steps.length}</span>
        </div>
        <p className="tour-tooltip-body">{current.content}</p>
        <div className="tour-tooltip-actions">
          <button className="tour-skip" onClick={finish}>Skip tour</button>
          <div className="tour-nav">
            {step > 0 && <button className="tour-prev" onClick={prev}>← Back</button>}
            <button className="tour-next" onClick={next}>
              {step + 1 === steps.length ? 'Finish' : 'Next →'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
