import * as fs from 'fs'
import * as path from 'path'
import * as yaml from 'js-yaml'
import matter from 'gray-matter'
import { execSync } from 'child_process'

// ==================== 类型定义 ====================

interface CleanRule {
  name: string
  description: string
  source: {
    repo: string
    path: string
    filePattern: string
    format: 'json' | 'jsonl' | 'markdown' | 'yaml'
  }
  target: {
    type: 'interview' | 'assessment'
    outputDir: string
    filename: string
    idPrefix?: string
  }
  mapping: Record<string, FieldMapping>
  filters?: FilterRule[]
  dedup?: {
    field: string
    strategy: 'keep-first' | 'keep-last'
  }
}

interface FieldMapping {
  source: string           // 字段名 或 'fixed'/'expr'/'extract'/'map'
  value?: string           // fixed 时的固定值
  field?: string           // extract/map 时的源字段
  pattern?: string         // extract 时的正则
  expression?: string      // expr 时的表达式
  values?: Record<string, string>  // map 时的值映射表
  default?: string         // 默认值
}

interface FilterRule {
  field: string
  minLength?: number
  maxLength?: number
  contains?: string
  notContains?: string
  in?: string[]
  notIn?: string[]
  regex?: string
}

// ==================== 文件解析 ====================

function parseJsonFile(filePath: string): any[] {
  const content = fs.readFileSync(filePath, 'utf-8')
  const data = JSON.parse(content)
  return Array.isArray(data) ? data : [data]
}

function parseJsonlFile(filePath: string): any[] {
  const content = fs.readFileSync(filePath, 'utf-8')
  return content.split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line))
}

function parseYamlFile(filePath: string): any[] {
  const content = fs.readFileSync(filePath, 'utf-8')
  const data = yaml.load(content)
  return Array.isArray(data) ? data : [data]
}

function parseMarkdownFile(filePath: string): any[] {
  const content = fs.readFileSync(filePath, 'utf-8')
  const results: any[] = []

  // 按二级标题分割成多道题
  const sections = content.split(/^## /m).filter(s => s.trim())

  for (const section of sections) {
    const lines = section.split('\n')
    const title = lines[0]?.trim() || ''
    const body = lines.slice(1).join('\n').trim()

    if (!title) continue

    // 尝试解析 frontmatter
    const fmResult = matter(body)
    results.push({
      title,
      content: fmResult.content.trim(),
      ...fmResult.data,
    })
  }

  // 如果没有二级标题，整个文件作为一条数据
  if (results.length === 0) {
    const fmResult = matter(content)
    results.push({
      title: path.basename(filePath, path.extname(filePath)),
      content: fmResult.content.trim(),
      ...fmResult.data,
    })
  }

  return results
}

function parseFile(filePath: string, format: string): any[] {
  switch (format) {
    case 'json': return parseJsonFile(filePath)
    case 'jsonl': return parseJsonlFile(filePath)
    case 'yaml': return parseYamlFile(filePath)
    case 'markdown': return parseMarkdownFile(filePath)
    default: throw new Error(`Unsupported format: ${format}`)
  }
}

// ==================== 字段映射 ====================

function applyMapping(source: any, mapping: Record<string, FieldMapping>): any {
  const result: any = {}

  for (const [targetField, rule] of Object.entries(mapping)) {
    switch (rule.source) {
      case 'fixed': {
        // 如果值是 JSON 字符串，尝试解析
        const val = rule.value ?? ''
        if (val.startsWith('[') || val.startsWith('{')) {
          try {
            result[targetField] = JSON.parse(val)
          } catch {
            result[targetField] = val
          }
        } else {
          result[targetField] = val
        }
        break
      }

      case 'expr': {
        // 简单表达式：支持 "field1 + ' - ' + field2" 形式
        let expr = rule.expression || ''
        expr = expr.replace(/\b(\w+)\b/g, (match) => {
          if (source[match] !== undefined) {
            return JSON.stringify(source[match])
          }
          return match
        })
        try {
          result[targetField] = eval(expr)
        } catch {
          result[targetField] = rule.default ?? ''
        }
        break
      }

      case 'extract': {
        const srcField = rule.field || ''
        const srcValue = String(source[srcField] || '')
        if (rule.pattern) {
          const regex = new RegExp(rule.pattern, 'gm')
          const matches: string[] = []
          let m
          while ((m = regex.exec(srcValue)) !== null) {
            matches.push(m[1] || m[0])
          }
          result[targetField] = matches
        } else {
          result[targetField] = srcValue
        }
        break
      }

      case 'map': {
        const srcField = rule.field || targetField
        const srcValue = String(source[srcField] || '')
        result[targetField] = rule.values?.[srcValue] ?? rule.default ?? srcValue
        break
      }

      default:
        // 直接取源字段
        result[targetField] = source[rule.source] ?? rule.default ?? ''
    }
  }

  return result
}

// ==================== 过滤 ====================

function applyFilters(item: any, filters: FilterRule[]): boolean {
  for (const filter of filters) {
    const value = String(item[filter.field] ?? '')

    if (filter.minLength !== undefined && value.length < filter.minLength) return false
    if (filter.maxLength !== undefined && value.length > filter.maxLength) return false
    if (filter.contains !== undefined && !value.includes(filter.contains)) return false
    if (filter.notContains !== undefined && value.includes(filter.notContains)) return false
    if (filter.in !== undefined && !filter.in.includes(value)) return false
    if (filter.notIn !== undefined && filter.notIn.includes(value)) return false
    if (filter.regex !== undefined && !new RegExp(filter.regex).test(value)) return false
  }
  return true
}

// ==================== 去重 ====================

function applyDedup(items: any[], field: string, strategy: string): any[] {
  const seen = new Map<string, any>()
  for (const item of items) {
    const key = String(item[field] || '').trim()
    if (!key) continue
    if (strategy === 'keep-last' || !seen.has(key)) {
      seen.set(key, item)
    }
  }
  return Array.from(seen.values())
}

// ==================== 文件收集 ====================

function collectFiles(dir: string, pattern: string): string[] {
  const results: string[] = []

  // 简单的 glob 匹配
  const ext = pattern.replace('*', '')
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const fullPath = path.join(d, entry.name)
      if (entry.isDirectory()) {
        walk(fullPath)
      } else if (entry.name.endsWith(ext)) {
        results.push(fullPath)
      }
    }
  }
  walk(dir)
  return results.sort()
}

// ==================== 主流程 ====================

async function clean(rulePath: string) {
  const rule: CleanRule = JSON.parse(fs.readFileSync(rulePath, 'utf-8'))
  console.log(`\n📦 执行清洗: ${rule.name}`)
  console.log(`   ${rule.description}`)

  // 1. clone 源仓库
  const tmpDir = path.join(__dirname, '..', '.tmp', rule.name.replace(/\s+/g, '-'))
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true })
  }

  console.log(`   ⬇️  克隆 ${rule.source.repo} ...`)
  execSync(`git clone --depth 1 "${rule.source.repo}" "${tmpDir}"`, { stdio: 'pipe' })

  // 2. 收集文件
  const sourceDir = path.join(tmpDir, rule.source.path)
  const files = collectFiles(sourceDir, rule.source.filePattern)
  console.log(`   📄 找到 ${files.length} 个文件`)

  if (files.length === 0) {
    console.log('   ⚠️  没有找到匹配的文件，跳过')
    fs.rmSync(tmpDir, { recursive: true })
    return
  }

  // 3. 解析文件
  let rawData: any[] = []
  for (const file of files) {
    try {
      const items = parseFile(file, rule.source.format)
      rawData.push(...items)
    } catch (e: any) {
      console.log(`   ⚠️  解析失败 ${path.basename(file)}: ${e.message}`)
    }
  }
  console.log(`   📊 解析得到 ${rawData.length} 条原始数据`)

  // 4. 字段映射
  let mappedData = rawData.map(item => applyMapping(item, rule.mapping))

  // 5. 过滤
  if (rule.filters && rule.filters.length > 0) {
    const before = mappedData.length
    mappedData = mappedData.filter(item => applyFilters(item, rule.filters!))
    console.log(`   🔍 过滤: ${before} → ${mappedData.length}`)
  }

  // 6. 去重
  if (rule.dedup) {
    const before = mappedData.length
    mappedData = applyDedup(mappedData, rule.dedup.field, rule.dedup.strategy)
    console.log(`   🔁 去重: ${before} → ${mappedData.length}`)
  }

  // 7. 生成 ID
  const prefix = rule.target.idPrefix || 'ext-'
  mappedData.forEach((item, i) => {
    if (!item.id) {
      item.id = `${prefix}${String(i + 1).padStart(3, '0')}`
    }
  })

  // 8. 写入输出文件
  const outputDir = path.join(__dirname, '..', rule.target.outputDir)
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }
  const outputPath = path.join(outputDir, rule.target.filename)
  fs.writeFileSync(outputPath, JSON.stringify(mappedData, null, 2), 'utf-8')
  console.log(`   ✅ 输出 ${mappedData.length} 条 → ${rule.target.outputDir}/${rule.target.filename}`)

  // 9. 清理
  fs.rmSync(tmpDir, { recursive: true })
}

// ==================== CLI 入口 ====================

async function main() {
  const args = process.argv.slice(2)
  const ruleDir = path.join(__dirname, 'rules')

  if (args.includes('--all')) {
    // 清洗所有规则
    const ruleFiles = fs.readdirSync(ruleDir)
      .filter(f => f.endsWith('.json'))
      .map(f => path.join(ruleDir, f))

    for (const ruleFile of ruleFiles) {
      try {
        await clean(ruleFile)
      } catch (e: any) {
        console.error(`❌ 清洗失败 ${path.basename(ruleFile)}: ${e.message}`)
      }
    }
  } else {
    // 清洗指定规则
    const ruleIdx = args.indexOf('--rule')
    const ruleFile = ruleIdx >= 0 ? args[ruleIdx + 1] : args[0]

    if (!ruleFile) {
      console.log('用法:')
      console.log('  npx tsx scripts/clean.ts --rule rules/xxx.json')
      console.log('  npx tsx scripts/clean.ts --all')
      return
    }

    // 尝试多个路径
    let rulePath: string
    if (path.isAbsolute(ruleFile)) {
      rulePath = ruleFile
    } else if (fs.existsSync(path.join(ruleDir, ruleFile))) {
      rulePath = path.join(ruleDir, ruleFile)
    } else if (fs.existsSync(path.join(ruleDir, path.basename(ruleFile)))) {
      rulePath = path.join(ruleDir, path.basename(ruleFile))
    } else {
      rulePath = path.resolve(ruleFile)
    }
    if (!fs.existsSync(rulePath)) {
      console.error(`规则文件不存在: ${rulePath}`)
      return
    }
    await clean(rulePath)
  }

  console.log('\n🎉 清洗完成!')
}

main().catch(console.error)
