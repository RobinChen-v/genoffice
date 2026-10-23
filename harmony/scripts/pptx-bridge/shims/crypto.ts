// Browser shim for node:crypto (read-only path). M1 opening/render needs no real
// sha256 (renderer never reads originalHash); a deterministic FNV-1a keeps the
// per-file identity stable so future save-diff logic can key on it.
export function createHash(_alg: string): { update(d: Uint8Array): unknown; digest(_enc: string): string } {
  let h = 0x811c9dc5
  return {
    update(data: Uint8Array) {
      for (const b of data) {
        h ^= b
        h = Math.imul(h, 0x01000193) >>> 0
      }
      return this
    },
    digest() {
      return h.toString(16).padStart(8, '0')
    },
  }
}
export function randomUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}