import { describe, it, expect, vi } from 'vitest'
import L from 'leaflet'
import { patchTooltipClickBehavior } from './tooltipFix'

type ProtoWithTooltip = {
  _openTooltip: (e: unknown) => unknown
  __tooltipClickPatched?: boolean
}

function resetProto(original: (e: unknown) => unknown) {
  const proto = L.Layer.prototype as unknown as ProtoWithTooltip
  proto._openTooltip = original
  delete proto.__tooltipClickPatched
}

describe('patchTooltipClickBehavior', () => {
  it('suppresses the tooltip on click when the layer also has a popup', () => {
    const original = vi.fn()
    resetProto(original)

    patchTooltipClickBehavior(L)

    const layer = { _openTooltip: (L.Layer.prototype as unknown as ProtoWithTooltip)._openTooltip, _popup: {} }
    layer._openTooltip.call(layer, { type: 'click' })
    expect(original).not.toHaveBeenCalled()
  })

  it('still opens the tooltip on hover (mouseover) even when a popup exists', () => {
    const original = vi.fn()
    resetProto(original)

    patchTooltipClickBehavior(L)

    const layer = { _openTooltip: (L.Layer.prototype as unknown as ProtoWithTooltip)._openTooltip, _popup: {} }
    layer._openTooltip.call(layer, { type: 'mouseover' })
    expect(original).toHaveBeenCalledTimes(1)
  })

  it('opens the tooltip on click for tooltip-only layers (no popup)', () => {
    const original = vi.fn()
    resetProto(original)

    patchTooltipClickBehavior(L)

    const layer = { _openTooltip: (L.Layer.prototype as unknown as ProtoWithTooltip)._openTooltip, _popup: undefined }
    layer._openTooltip.call(layer, { type: 'click' })
    expect(original).toHaveBeenCalledTimes(1)
  })

  it('is idempotent — patching twice does not double-wrap', () => {
    const original = vi.fn()
    resetProto(original)

    patchTooltipClickBehavior(L)
    const afterFirst = (L.Layer.prototype as unknown as ProtoWithTooltip)._openTooltip
    patchTooltipClickBehavior(L)
    const afterSecond = (L.Layer.prototype as unknown as ProtoWithTooltip)._openTooltip
    expect(afterFirst).toBe(afterSecond)
  })
})
