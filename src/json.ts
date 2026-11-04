import type { JsonValue } from '@deepseek-ai/dsh-util-values'

type Fragment = string | { value: JsonValue }

/** 将管线已验证的 JSON 渲染为紧凑文本；深层返回值不占用递归调用栈。 */
export function renderJson(value: JsonValue): string {
  const fragments: Fragment[] = [{ value }]
  const chunks: string[] = []
  while (fragments.length > 0) {
    const fragment = fragments.pop()!
    if (typeof fragment === 'string') {
      chunks.push(fragment)
      continue
    }
    const current = fragment.value
    if (current === null || typeof current !== 'object') {
      chunks.push(JSON.stringify(current))
    } else if (Array.isArray(current)) {
      chunks.push('[')
      fragments.push(']')
      for (let index = current.length - 1; index >= 0; index--) {
        fragments.push({ value: current[index]! })
        if (index > 0) fragments.push(',')
      }
    } else {
      chunks.push('{')
      fragments.push('}')
      const entries = Object.entries(current)
      for (let index = entries.length - 1; index >= 0; index--) {
        const [key, child] = entries[index]!
        fragments.push({ value: child }, `${index > 0 ? ',' : ''}${JSON.stringify(key)}:`)
      }
    }
  }
  return chunks.join('')
}
