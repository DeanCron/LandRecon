import { afterEach, describe, expect, it } from 'vitest'
import L from 'leaflet'
import { addBaseLayer } from './baseLayer'

const maps: L.Map[] = []

function makeMap(): L.Map {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const map = L.map(el, { center: [33.64, -84.43], zoom: 13 })
  maps.push(map)
  return map
}

// Stand-in for the protomaps-leaflet noise layer, which is a canvas GridLayer.
class CanvasOverlay extends L.GridLayer {
  protected createTile(): HTMLElement {
    return document.createElement('canvas')
  }
}

function makeOverlay(): L.GridLayer {
  return new CanvasOverlay()
}

function makeBase(): L.TileLayer {
  return L.tileLayer('https://tiles.example.test/base/{z}/{x}/{y}.png')
}

function paintOrder(map: L.Map): HTMLElement[] {
  const containers = [...map.getPane('tilePane')!.children] as HTMLElement[]
  // Equal z-index paints in DOM order; otherwise the higher z-index wins.
  return containers
    .map((el, domIndex) => ({ el, domIndex, z: Number(el.style.zIndex) || 0 }))
    .sort((a, b) => a.z - b.z || a.domIndex - b.domIndex)
    .map(({ el }) => el)
}

afterEach(() => {
  while (maps.length) maps.pop()!.remove()
  document.body.innerHTML = ''
})

describe('addBaseLayer', () => {
  it('keeps overlays visible when the base layer resolves after them', () => {
    const map = makeMap()
    const overlay = makeOverlay().addTo(map)
    const base = makeBase()

    addBaseLayer(map, base)

    expect(paintOrder(map)).toEqual([base.getContainer(), overlay.getContainer()])
  })

  it('keeps the base layer beneath overlays added afterwards', () => {
    const map = makeMap()
    const base = makeBase()
    addBaseLayer(map, base)

    const overlay = makeOverlay().addTo(map)

    expect(paintOrder(map)).toEqual([base.getContainer(), overlay.getContainer()])
  })

  it('keeps a swapped-in base layer beneath existing overlays', () => {
    const map = makeMap()
    const street = makeBase()
    addBaseLayer(map, street)
    const overlay = makeOverlay().addTo(map)

    map.removeLayer(street)
    const satellite = makeBase()
    addBaseLayer(map, satellite)

    expect(paintOrder(map)).toEqual([satellite.getContainer(), overlay.getContainer()])
  })

  it('stays beneath several overlays added before it', () => {
    const map = makeMap()
    const first = makeOverlay().addTo(map)
    const second = makeOverlay().addTo(map)
    const base = makeBase()

    addBaseLayer(map, base)

    expect(paintOrder(map)[0]).toBe(base.getContainer())
    expect(paintOrder(map).slice(1)).toEqual([first.getContainer(), second.getContainer()])
  })
})
