// node:stream/promises shim — savePptxToFile is M2+.
export async function pipeline(): Promise<never> {
  throw new Error('node:stream/promises pipeline unavailable in browser shell (M2+)')
}