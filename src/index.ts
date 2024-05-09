import MagicString from 'magic-string'
import path from 'node:path'
import { cwd } from 'node:process'
import { type Plugin } from 'vite'
import {
  ExportAllDeclaration,
  ExportNamedDeclaration,
  Identifier,
  ModuleDeclaration,
  Statement,
  VariableDeclaration,
  VariableDeclarator,
  parse as ast,
} from 'acorn'

let entry: string[]

enum ExpType {
  ExportNamedDeclaration = 'ExportNamedDeclaration',
  ExportDefaultDeclaration = 'ExportDefaultDeclaration',
  ExportAllDeclaration = 'ExportAllDeclaration',
}

export function cjs(): Plugin {
  return {
    name: 'vite-plugin-merge-exports',

    async config({ build }) {
      if (!build?.lib) return

      const resolvedEntry = typeof build.lib.entry == 'object' ? Object.values(build.lib.entry) : [build.lib.entry]

      // TODO: 路径兼容问题
      entry = resolvedEntry.map((it) => {
        if (it.startsWith('.')) {
          return path.join(cwd(), it).replace(new RegExp(`\\${path.sep}`, 'g'), '/')
        }
        return it.replace(new RegExp(`${path.sep}`, 'g'), '/')
      })
    },

    async transform(code, id) {
      if (!entry || !entry.includes(id)) return
      const { body } = ast(code, {
        ecmaVersion: 'latest',
        sourceType: 'module',
      })

      let hostName: string | undefined
      let exports: (ExportNamedDeclaration | ExportAllDeclaration)[] = []

      for (const node of body) {
        if (node.type == ExpType.ExportDefaultDeclaration) {
          hostName = (node.declaration as any).name
        } else if (node.type == ExpType.ExportNamedDeclaration || node.type == ExpType.ExportAllDeclaration) {
          exports.push(node)
        }
      }

      if (!hostName) return null

      let gen: string[] = []
      const s = new MagicString(code)
      /**
        // TODO: 多次从同一模块导入导出
        export { help } from './helper'
        export * as helper from './helper'

        import helper from './helper'
        host.${helper} = helper
        host.${help} = helper.help
      */
      let imports = []

      exports.map((node) => {
        // @ts-ignore
        const { type, start, end, source, exported } = node

        // export * from ''
        if (type == ExpType.ExportAllDeclaration) {
          s.remove(start, end)

          gen.push(`import ${(exported as Identifier).name} from '${source.value}'`)
          gen.push(`${hostName}.${(exported as Identifier).name} = ${(exported as Identifier).name}`)

          return
        }

        const { declaration, specifiers } = node

        if (declaration) {
          // export var
          s.remove(start, start + 'export'.length + 1)

          const declarationName = ((declaration as VariableDeclaration).declarations[0].id as Identifier).name
          gen.push(`${hostName}.${declarationName} = ${declarationName}`)
        } else {
          // export x from 'x'
          s.remove(start, end)

          specifiers.map((sp) => {
            gen.push(`${hostName}.${(sp.exported as Identifier).name} = ${(sp.local as Identifier).name}`)
          })

          if (source) {
            gen.push(`import { ${specifiers.map((sp) => (sp.local as Identifier).name)} } from '${source.value}'`)
          }
        }
      })

      s.append(gen.join('\r\n'))

      return {
        code: s.toString(),
        map: s.generateMap(),
      }
    },
  }
}