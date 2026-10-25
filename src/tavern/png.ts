export interface PngTextChunk {
  keyword: string
  text: string
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false
  return PNG_SIGNATURE.every((b, i) => bytes[i] === b)
}

/**
 * 按 chunk 走一遍，取出所有 tEXt。
 * 不能用「在字节里搜 chara 字符串」的办法——那样会误命中像素数据。
 * CRC 不校验（与酒馆自身一致），但结构必须合法。
 */
export function readPngTextChunks(bytes: Uint8Array): PngTextChunk[] {
  if (!isPng(bytes)) {
    throw new Error('这不是一个 PNG 文件。')
  }

  const chunks: PngTextChunk[] = []
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  let p = 8
  while (p + 8 <= bytes.length) {
    const length = view.getUint32(p, false)
    const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7])

    const dataStart = p + 8
    const dataEnd = dataStart + length
    if (dataEnd > bytes.length) {
      throw new Error('PNG 结构损坏：chunk 长度超出了文件末尾。')
    }

    if (type === 'tEXt') {
      const data = bytes.subarray(dataStart, dataEnd)
      const nul = data.indexOf(0)
      if (nul > 0) {
        const keyword = Buffer.from(data.subarray(0, nul)).toString('latin1')
        const text = Buffer.from(data.subarray(nul + 1)).toString('latin1')
        chunks.push({ keyword, text })
      }
    }

    if (type === 'IEND') break
    p = dataEnd + 4 // 跳过 CRC
  }

  return chunks
}

export interface EmbeddedCard {
  json: unknown
  keyword: string
}

/** 去掉承载角色卡的 tEXt 段，只留纯图片——头像不必把整张卡的 base64 再存一遍。 */
export function stripCardTextChunks(bytes: Uint8Array): Uint8Array {
  if (!isPng(bytes)) return bytes

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const kept: Uint8Array[] = [bytes.subarray(0, 8)]

  let p = 8
  while (p + 8 <= bytes.length) {
    const length = view.getUint32(p, false)
    const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7])
    const end = p + 12 + length
    if (end > bytes.length) break

    let drop = false
    if (type === 'tEXt') {
      const data = bytes.subarray(p + 8, p + 8 + length)
      const nul = data.indexOf(0)
      if (nul > 0) {
        const keyword = Buffer.from(data.subarray(0, nul)).toString('latin1').toLowerCase()
        drop = keyword === 'chara' || keyword === 'ccv3'
      }
    }

    if (!drop) kept.push(bytes.subarray(p, end))
    if (type === 'IEND') break
    p = end
  }

  const total = kept.reduce((n, part) => n + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of kept) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** ccv3 优先于 chara（V3 规范要求）；都字符串比较不区分大小写。 */
export function extractCardFromPng(bytes: Uint8Array): EmbeddedCard {
  const chunks = readPngTextChunks(bytes)
  const pick = (kw: string) => chunks.find((c) => c.keyword.toLowerCase() === kw)
  const hit = pick('ccv3') ?? pick('chara')

  if (!hit) {
    throw new Error(
      '这个 PNG 里没有角色卡数据（没有 chara 或 ccv3 段）。它可能只是一张普通图片。',
    )
  }

  let decoded: string
  try {
    decoded = Buffer.from(hit.text, 'base64').toString('utf8')
  } catch {
    throw new Error('PNG 里的角色卡数据不是合法的 base64。')
  }

  try {
    return { json: JSON.parse(decoded), keyword: hit.keyword }
  } catch {
    throw new Error('PNG 里的角色卡数据 base64 解出来不是合法 JSON，文件可能已损坏。')
  }
}
