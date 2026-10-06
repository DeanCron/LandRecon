import { describe, expect, it } from 'vitest'
import { cameraPopup } from './cameras'
import { transitPopup } from './transit'

const PAYLOAD = '<img src=x onerror=alert(1)>'

describe('popup HTML escaping', () => {
  it('escapes OSM camera manufacturer and node id', () => {
    const html = cameraPopup({
      id: 'node/1"><script>x</script>',
      lat: 0,
      lon: 0,
      manufacturer: PAYLOAD,
      operator: PAYLOAD,
      direction: '',
      isFlock: false,
    })
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; ALPR')
  })

  it('escapes OSM transit stop names', () => {
    const html = transitPopup({ lat: 0, lon: 0, name: PAYLOAD, type: 'bus' })
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })
})
