// Tiny utilities used across MapPage.

export function debounce<TArgs extends unknown[]>(
  fn: (...args: TArgs) => void,
  waitMs: number,
): ((...args: TArgs) => void) & { cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  const wrapped = (...args: TArgs) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      fn(...args)
    }, waitMs)
  }
  wrapped.cancel = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }
  return wrapped
}

// Round a coordinate to a fixed precision. 3 decimals ≈ 110 m, which is
// the granularity at which we treat two addresses as identical for caching
// purposes.
export function quantizeCoord(value: number, decimals = 3): string {
  return value.toFixed(decimals)
}
