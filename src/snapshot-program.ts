import ts from 'typescript'

export const SNAPSHOT_MAX_BYTES = 1024 * 1024
export const SNAPSHOT_INTERNAL_PREFIX = '__codebridge_snapshot_'
export type SnapshotDeclarationKind = 'const' | 'let' | 'var'
export interface SnapshotVariable { name: string; kind: SnapshotDeclarationKind }
export interface SnapshotEntry extends SnapshotVariable { json: string }
export interface EncodedSnapshot { entries: SnapshotEntry[]; omitted: string[]; overflow: boolean }

/** Only identifiers, never source fragments, may enter an internal read/declaration. */
export function isSnapshotIdentifier(name: string): boolean {
  if (name.startsWith(SNAPSHOT_INTERNAL_PREFIX) || name.startsWith('codebridge_snapshot_') || ['eval', 'arguments', 'await', 'yield', 'let', 'implements', 'interface', 'package', 'private', 'protected', 'public', 'static'].includes(name)) return false
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, name)
  const token = scanner.scan()
  const identifier = token === ts.SyntaxKind.Identifier || token >= ts.SyntaxKind.AbstractKeyword && token <= ts.SyntaxKind.OfKeyword
  return identifier && scanner.getTokenText() === name && scanner.scan() === ts.SyntaxKind.EndOfFileToken
}

/** Deliberately do not descend into blocks, loops, functions or namespaces. */
export function collectSnapshotVariables(code: string): SnapshotVariable[] {
  const source = ts.createSourceFile('cell.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const variables = new Map<string, SnapshotDeclarationKind>()
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement) || statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword)) continue
    const flags = statement.declarationList.flags
    if (flags & ts.NodeFlags.Using) continue
    const kind = flags & ts.NodeFlags.Const ? 'const' : flags & ts.NodeFlags.Let ? 'let' : 'var'
    const pending: ts.BindingName[] = statement.declarationList.declarations.map(declaration => declaration.name).reverse()
    while (pending.length > 0) {
      const name = pending.pop()!
      if (ts.isIdentifier(name)) {
        if (isSnapshotIdentifier(name.text)) variables.set(name.text, kind)
      } else {
        for (let index = name.elements.length - 1; index >= 0; index--) {
          const element = name.elements[index]!
          if (ts.isBindingElement(element)) pending.push(element.name)
        }
      }
    }
  }
  return [...variables].map(([name, kind]) => ({ name, kind }))
}

/** Runtime declarations that are reported but never read or replayed. */
export function collectUnsupportedSnapshotNames(code: string): string[] {
  const source = ts.createSourceFile('cell.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const names = new Set<string>()
  const add = (name: ts.Identifier | undefined): void => {
    if (name && isSnapshotIdentifier(name.text)) names.add(name.text)
  }
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.body || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) {
      add(statement.name)
    } else if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause
      if (!clause || clause.isTypeOnly) continue
      add(clause.name)
      if (clause.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) add(clause.namedBindings.name)
        else for (const specifier of clause.namedBindings.elements) if (!specifier.isTypeOnly) add(specifier.name)
      }
    } else if (ts.isImportEqualsDeclaration(statement) && !statement.isTypeOnly) add(statement.name)
  }
  return [...names]
}

/**
 * Self-contained trusted helper: its emitted JS source is installed before user cells.
 * Capture intrinsics once, including methods that user code can subsequently replace.
 * No model object crosses to the Host until it has become an inert JSON string.
 */
export function createSnapshotCodec(isProxy: (value: unknown) => boolean, byteLength: (value: string) => number) {
  const create = Object.create
  const defineProperty = Object.defineProperty
  const getPrototypeOf = Object.getPrototypeOf
  const getDescriptor = Object.getOwnPropertyDescriptor
  const ownKeys = Reflect.ownKeys
  const apply = Reflect.apply
  const hasOwnProperty = Object.prototype.hasOwnProperty
  const objectPrototype = Object.prototype
  const arrayPrototype = Array.prototype
  const isArray = Array.isArray
  const finite = Number.isFinite
  const integer = Number.isInteger
  const same = Object.is
  const stringify = JSON.stringify
  const parse = JSON.parse
  const weakMap = WeakMap
  const weakGet = WeakMap.prototype.get
  const weakSet = WeakMap.prototype.set
  const global = globalThis
  const invalid = {}
  const tooLarge = {}
  const has = (value: object, key: PropertyKey): boolean => apply(hasOwnProperty, value, [key])

  const defineOwn = (target: object, key: PropertyKey, value: unknown): void => {
    const descriptor = create(null) as PropertyDescriptor
    descriptor.value = value
    descriptor.enumerable = true
    descriptor.writable = true
    descriptor.configurable = true
    defineProperty(target, key, descriptor)
  }

  type Reader = [string, SnapshotDeclarationKind, () => unknown]
  type Task = { value: unknown } | { text: string }
  return {
    decode(json: string): unknown { return parse(json) },
    capture(readers: Reader[], maxBytes: number): EncodedSnapshot {
      const seen = new weakMap<object, number>()
      const rejected: boolean[] = []
      const encoded: Array<string | undefined> = []
      let bytes = 0
      let overflow = false
      const append = (parts: string[], text: string): void => {
        bytes += byteLength(text)
        if (bytes > maxBytes) throw tooLarge
        defineOwn(parts, parts.length, text)
      }
      for (let root = 0; root < readers.length; root++) {
        const reader = readers[root]!
        const parts: string[] = []
        try {
          // A var binding can be redefined as a global accessor after its declaration.
          if (reader[1] === 'var') {
            const descriptor = getDescriptor(global, reader[0])
            if (descriptor && !has(descriptor, 'value')) throw invalid
          }
          const tasks: Task[] = [{ value: reader[2]() }]
          while (tasks.length > 0) {
            const task = tasks[tasks.length - 1]!
            tasks.length--
            if (has(task, 'text')) { append(parts, (task as { text: string }).text); continue }
            const value = (task as { value: unknown }).value
            if (value === null) { append(parts, 'null'); continue }
            const type = typeof value
            if (type === 'string' || type === 'boolean') {
              if (type === 'string' && (value as string).length > maxBytes - bytes) throw tooLarge
              append(parts, stringify(value)); continue
            }
            if (type === 'number') {
              if (!finite(value) || same(value, -0)) throw invalid
              append(parts, stringify(value)); continue
            }
            if (type !== 'object' || isProxy(value)) throw invalid
            const object = value as object
            const previous = apply(weakGet, seen, [object]) as number | undefined
            if (previous !== undefined) { defineOwn(rejected, previous, true); throw invalid }
            apply(weakSet, seen, [object, root])
            const array = isArray(object)
            const prototype = getPrototypeOf(object)
            if (prototype !== (array ? arrayPrototype : objectPrototype)) throw invalid
            const keys = ownKeys(object)
            const values: Array<{ key: string; value: unknown }> = []
            let length = 0
            if (array) {
              const descriptor = getDescriptor(object, 'length')!
              length = descriptor.value as number
              if (!integer(length) || length < 0 || keys.length !== length + 1) throw invalid
            }
            for (let index = 0; index < keys.length; index++) {
              const key = keys[index]!
              if (array && key === 'length') continue
              if (typeof key !== 'string' || key === 'toJSON') throw invalid
              const descriptor = getDescriptor(object, key)!
              if (!has(descriptor, 'value') || !descriptor.enumerable) throw invalid
              if (array && key !== stringify(values.length)) throw invalid
              defineOwn(values, values.length, { key, value: descriptor.value })
            }
            append(parts, array ? '[' : '{')
            defineOwn(tasks, tasks.length, { text: array ? ']' : '}' })
            for (let index = values.length - 1; index >= 0; index--) {
              const item = values[index]!
              defineOwn(tasks, tasks.length, { value: item.value })
              if (!array) {
                if (item.key.length > maxBytes - bytes) throw tooLarge
                defineOwn(tasks, tasks.length, { text: stringify(item.key) + ':' })
              }
              if (index > 0) defineOwn(tasks, tasks.length, { text: ',' })
            }
          }
          // Avoid mutable Array.prototype.join, too.
          let json = ''
          for (let index = 0; index < parts.length; index++) json += parts[index]!
          defineOwn(encoded, root, json)
        } catch (error) {
          defineOwn(rejected, root, true)
          if (error === tooLarge) { overflow = true; break }
          // A read can throw (e.g. uninitialized binding); never stringify that error.
        }
      }
      const entries: SnapshotEntry[] = []
      const omitted: string[] = []
      for (let index = 0; index < readers.length; index++) {
        const reader = readers[index]!
        if (overflow || (has(rejected, index) && rejected[index]) || !has(encoded, index)) defineOwn(omitted, omitted.length, reader[0])
        else defineOwn(entries, entries.length, { name: reader[0], kind: reader[1], json: encoded[index]! })
      }
      return { entries, omitted, overflow }
    },
  }
}

function assertInternalName(name: string): void {
  if (!/^__codebridge_snapshot_[a-f0-9]+$/.test(name)) throw new Error('Invalid internal snapshot identifier')
}

export function snapshotProbeProgram(marker: string): string {
  assertInternalName(marker)
  return `typeof ${marker} !== 'undefined'`
}

/** Install intrinsics before any restored binding can shadow a built-in name. */
export function snapshotBootstrapProgram(marker: string, binding: string): string {
  assertInternalName(marker)
  if (!/^codebridge_snapshot_[a-f0-9]+$/.test(binding)) throw new Error('Invalid snapshot binding identifier')
  return `const ${marker} = await (async () => {\nconst util = await import('node:util');\nconst buffer = await import('node:buffer');\nreturn (${createSnapshotCodec.toString()})(util.types.isProxy, buffer.Buffer.byteLength);\n})();\nconst ${marker}_data = await ${binding}.load({});\nvoid 0`
}

/** Source contains identifiers only; JSON payload arrives exclusively through the binding. */
export function snapshotRestoreProgram(marker: string, entries: SnapshotVariable[]): string {
  assertInternalName(marker)
  const declarations = entries.map((entry, index) => {
    if (!isSnapshotIdentifier(entry.name) || !['const', 'let', 'var'].includes(entry.kind)) throw new Error('Invalid snapshot declaration')
    return `${entry.kind} ${entry.name} = ${marker}.decode(${marker}_data[${index}]);`
  })
  return `${declarations.join('\n')}\nvoid 0`
}

export function snapshotCaptureProgram(marker: string, variables: SnapshotVariable[]): string {
  assertInternalName(marker)
  const readers = variables.map(variable => {
    if (!isSnapshotIdentifier(variable.name) || !['const', 'let', 'var'].includes(variable.kind)) throw new Error('Invalid snapshot read')
    return `[${JSON.stringify(variable.name)},${JSON.stringify(variable.kind)},()=>${variable.name}]`
  })
  return `${marker}.capture([${readers.join(',')}],${SNAPSHOT_MAX_BYTES})`
}
