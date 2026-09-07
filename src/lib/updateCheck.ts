export const CURRENT_VERSION = '1.3.2'
export const GITHUB_REPO = 'figamore/FigUI'
export const DISMISSED_VERSION_KEY = 'dismissed_update_version'

export function semverGt(a: string, b: string): boolean {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (da > db) return true
    if (da < db) return false
  }
  return false
}
