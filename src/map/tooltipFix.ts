import type L from 'leaflet'

type TooltipClickPatchTarget = {
  _openTooltip: (e: { type?: string }) => unknown
  _popup?: unknown
  __tooltipClickPatched?: boolean
}

// Leaflet (1.9.x) binds a layer's `click` event to open its tooltip in
// addition to the popup's own click handler (see leaflet-src
// `_initTooltipInteractions`, where `events.click = this._openTooltip`).
//
// On a desktop this is harmless because hover already governs the tooltip,
// but on touch devices a single tap opens BOTH the simple hover tooltip and
// the detailed popup — and because no `mouseout` ever fires on touch, the
// tooltip stays stuck on screen behind/over the popup.
//
// This patch enforces one consistent rule on every device: hover shows the
// simple tooltip (desktop only) and a click/tap opens the detailed popup. It
// suppresses the tooltip's *click* trigger whenever the same layer also has a
// popup. Hover (`mouseover`) and keyboard focus are untouched, and
// tooltip-only overlays (flood/power/AQI) keep their tap-to-show behavior
// because they have no popup. Idempotent: safe to call more than once.
export function patchTooltipClickBehavior(leaflet: typeof L): void {
  const proto = leaflet.Layer?.prototype as unknown as TooltipClickPatchTarget | undefined
  if (!proto || proto.__tooltipClickPatched) return
  const original = proto._openTooltip
  if (typeof original !== 'function') return

  proto._openTooltip = function (this: TooltipClickPatchTarget, e: { type?: string }) {
    if (e && e.type === 'click' && this._popup) return undefined
    return original.call(this, e)
  }
  proto.__tooltipClickPatched = true
}
