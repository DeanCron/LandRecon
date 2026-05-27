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
  const tooltipRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const timer = setTimeout(() => {
      if (forceShow || localStorage.getItem(storageKey) !== '1') setActive(true)
    }, delay)
    return () => clearTimeout(timer)
  }, [storageKey, delay, forceShow])

  const measureTarget = useCallback(() => {
    if (!active || step >= steps.length) return
    const el = document.querySelector(steps[step].selector) as HTMLElement | null
    if (el) {
      const r = el.getBoundingClientRect()
      setRect(r)
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    } else {
      setRect(null)
    }
  }, [active, step, steps])

  useEffect(() => {
    if (!active) return
    steps[step]?.beforeShow?.()
    measureTarget()
    window.addEventListener('resize', measureTarget)
    return () => window.removeEventListener('resize', measureTarget)
  }, [active, step, measureTarget, steps])

  const finish = useCallback(() => {
    steps[step]?.afterHide?.()
    localStorage.setItem(storageKey, '1')
    setActive(false)
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
  const tooltipW = 320

  let tooltipStyle: React.CSSProperties = {}
  if (rect) {
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    const spaceRight = window.innerWidth - rect.right
    const spaceLeft = rect.left
    const spaceBottom = window.innerHeight - rect.bottom
    const spaceTop = rect.top

    let pos = current.position || 'bottom'
    if (pos === 'left' && spaceLeft < tooltipW + 30) pos = spaceRight > tooltipW + 30 ? 'right' : 'bottom'
    if (pos === 'right' && spaceRight < tooltipW + 30) pos = spaceLeft > tooltipW + 30 ? 'left' : 'bottom'
    if (pos === 'bottom' && spaceBottom < 200) pos = 'top'
    if (pos === 'top' && spaceTop < 200) pos = 'bottom'

    switch (pos) {
      case 'bottom':
        tooltipStyle = { top: rect.bottom + pad + 8, left: Math.max(12, Math.min(cx - tooltipW / 2, window.innerWidth - tooltipW - 16)) }
        break
      case 'top':
        tooltipStyle = { bottom: window.innerHeight - rect.top + pad + 8, left: Math.max(12, Math.min(cx - tooltipW / 2, window.innerWidth - tooltipW - 16)) }
        break
      case 'left':
        tooltipStyle = { top: Math.max(12, Math.min(cy - 60, window.innerHeight - 220)), right: window.innerWidth - rect.left + pad + 8 }
        break
      case 'right':
        tooltipStyle = { top: Math.max(12, Math.min(cy - 60, window.innerHeight - 220)), left: rect.right + pad + 8 }
        break
    }
  } else {
    tooltipStyle = { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }
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
