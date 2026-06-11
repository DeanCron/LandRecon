export const LR_DEBUG =
  typeof localStorage !== 'undefined' && localStorage.getItem('LR_DEBUG') === '1'

export function dbg(tag: string, ...args: unknown[]) {
  if (LR_DEBUG) console.debug(`[LR:${tag}]`, ...args)
}
