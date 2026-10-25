/** 标签输入框的文本 → 标签数组。顿号、中英文逗号、空白都算分隔符。 */
export function parseTags(text: string): string[] {
  return text
    .split(/[,，、\s]+/)
    .map((t) => t.trim())
    .filter(Boolean)
}

/** 标签数组 → 输入框文本。 */
export function formatTags(tags: string[] | undefined): string {
  return (tags ?? []).join('、')
}
