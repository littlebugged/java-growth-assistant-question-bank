import * as fs from 'fs'
import * as path from 'path'
import Anthropic from '@anthropic-ai/sdk'
import * as dotenv from 'dotenv'

dotenv.config({ path: path.join(__dirname, '..', '.env') })

// ==================== 常量 ====================

const TARGET_FORMAT = `
## 面试题 (InterviewQuestion) 格式
存放目录: interview/
文件格式: JSON 数组，每个元素:
{
  "id": "ij-01",           // 唯一 ID，前缀+数字
  "category": "java",      // 分类，13 选 1
  "difficulty": "junior",  // 难度: junior/mid/senior
  "question": "问题描述",   // 面试题题目
  "answer": "详细答案",     // 完整答案文本
  "keyPoints": ["要点1"],  // 核心要点数组
  "followUp": ["追问1"]    // 追问数组(可选)
}
category 可选: java, jvm, concurrency, spring, mysql, redis, distributed, systemDesign, network, devops, algorithm, project, behavioral

## 评估题 (Question) 格式
存放目录: assessment/
文件格式: JSON 数组，每个元素:
{
  "id": "jb-01",
  "dimension": "javaBasics",   // 维度，6 选 1
  "difficulty": "basic",       // 难度: basic/intermediate/advanced
  "title": "题目描述",
  "options": [
    { "label": "选项A", "value": "a", "score": 1 },
    { "label": "选项B", "value": "b", "score": 4 }
  ],
  "answer": "b",               // 正确选项的 value
  "explanation": "解析"
}
dimension 可选: javaBasics, jvm, concurrency, spring, database, architecture
`

const CLEAN_RULE_FORMAT = `
清洗规则 JSON 格式:
{
  "name": "规则名称",
  "description": "规则描述",
  "source": {
    "repo": "GitHub 仓库地址",
    "path": "数据文件所在子目录(相对路径)",
    "filePattern": "*.json 或 *.md 或 *.yaml",
    "format": "json | jsonl | markdown | yaml"
  },
  "target": {
    "type": "interview 或 assessment",
    "outputDir": "interview 或 assessment",
    "filename": "输出文件名.json",
    "idPrefix": "ID 前缀，如 ij- 或 jb- 或自定义"
  },
  "mapping": {
    "字段名": { "source": "源字段名" },                    // 直接映射
    "字段名": { "source": "fixed", "value": "固定值" },    // 固定值
    "字段名": { "source": "map", "field": "源字段", "values": {"源值": "目标值"}, "default": "默认值" },  // 值映射
    "字段名": { "source": "extract", "field": "源字段", "pattern": "正则表达式" }  // 正则提取
  },
  "filters": [
    { "field": "字段名", "minLength": 10 }
  ],
  "dedup": {
    "field": "字段名",
    "strategy": "keep-first"
  }
}
`

// ==================== 仓库分析 ====================

interface RepoAnalysis {
  repoUrl: string
  fileTree: string
  fileStats: Record<string, number>
  samples: Array<{ path: string; content: string; format: string }>
}

function analyzeRepo(repoUrl: string): RepoAnalysis {
  const tmpDir = path.join(__dirname, '..', '.tmp', 'analyze-' + Date.now())

  console.log(`⬇️  克隆仓库: ${repoUrl}`)
  const { execSync } = require('child_process')
  execSync(`git clone --depth 1 "${repoUrl}" "${tmpDir}"`, { stdio: 'pipe' })

  // 扫描文件结构
  const fileStats: Record<string, number> = []
  const allFiles: string[] = []
  const MAX_DEPTH = 4

  function walk(dir: string, depth: number, prefix: string) {
    if (depth > MAX_DEPTH) return
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== '.git')

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        const relPath = path.join(prefix, entry.name)

        if (entry.isDirectory()) {
          walk(fullPath, depth + 1, relPath)
        } else {
          allFiles.push(relPath)
          const ext = path.extname(entry.name).toLowerCase()
          fileStats[ext] = (fileStats[ext] || 0) + 1
        }
      }
    } catch {}
  }

  walk(tmpDir, 0, '')

  // 生成目录树（只显示前 50 行）
  const treeLines = allFiles.slice(0, 50)
  const fileTree = treeLines.join('\n') + (allFiles.length > 50 ? `\n... 共 ${allFiles.length} 个文件` : '')

  // 抽样读取：每种主要格式取 1-2 个样本
  const samples: RepoAnalysis['samples'] = []
  const sampleExts = ['.json', '.jsonl', '.md', '.yaml', '.yml']
  const sampledExts = new Set<string>()

  for (const file of allFiles) {
    const ext = path.extname(file).toLowerCase()
    if (!sampleExts.includes(ext) || sampledExts.size >= 4) continue
    if (sampledExts.has(ext) && samples.length >= 6) continue

    try {
      const fullPath = path.join(tmpDir, file)
      const stat = fs.statSync(fullPath)
      if (stat.size > 50000) continue // 跳过大文件

      const content = fs.readFileSync(fullPath, 'utf-8')
      const format = ext === '.jsonl' ? 'jsonl' : ext === '.yml' ? 'yaml' : ext.slice(1)

      samples.push({
        path: file,
        content: content.slice(0, 3000), // 只取前 3000 字符
        format,
      })
      sampledExts.add(ext)
    } catch {}
  }

  // 清理
  fs.rmSync(tmpDir, { recursive: true, force: true })

  return { repoUrl, fileTree, fileStats, samples }
}

// ==================== AI 分析 ====================

async function generateRule(analysis: RepoAnalysis): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error('请设置 ANTHROPIC_API_KEY 环境变量，或在 .env 文件中配置')
  }

  const client = new Anthropic({ apiKey })

  // 构建 prompt
  let prompt = `你是数据清洗专家。我有一个题库系统，需要分析 GitHub 仓库的数据格式，判断能否清洗成目标格式。

${TARGET_FORMAT}

${CLEAN_RULE_FORMAT}

---

现在分析这个仓库:

**仓库地址:** ${analysis.repoUrl}

**文件结构:**
\`\`\`
${analysis.fileTree}
\`\`\`

**文件类型统计:**
${Object.entries(analysis.fileStats).map(([ext, count]) => `  ${ext || '(无后缀)'}: ${count} 个`).join('\n')}
`

  // 添加样本
  for (const sample of analysis.samples) {
    prompt += `\n**样本文件: ${sample.path}** (格式: ${sample.format})
\`\`\`${sample.format}
${sample.content}
\`\`\`
`
  }

  prompt += `
---

请完成以下任务:

1. **判断**: 这个仓库的数据能否清洗成面试题或评估题格式？（能/不能/部分能）
2. **分析**: 如果能，数据的主要特征是什么？哪些字段可以映射？
3. **生成规则**: 直接输出一个完整的清洗规则 JSON（不要额外解释，直接输出 JSON）

注意:
- 只输出 JSON，不要有其他内容
- 如果仓库有多种数据格式，选择最适合的一种
- mapping 中的字段名必须严格匹配目标格式
- 如果源数据没有某些字段（如 keyPoints），用 fixed 设为空数组 "[]"
- category/dimension 的值映射要完整覆盖源数据中所有可能的值
`

  console.log('🤖 正在分析仓库结构和数据格式...')

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  })

  const text = response.content[0].type === 'text' ? response.content[0].text : ''
  return text
}

// ==================== 主流程 ====================

async function main() {
  const args = process.argv.slice(2)
  const repoUrl = args[0]

  if (!repoUrl) {
    console.log('用法:')
    console.log('  npx tsx scripts/generate-rule.ts <GitHub 仓库地址>')
    console.log('')
    console.log('示例:')
    console.log('  npx tsx scripts/generate-rule.ts https://github.com/Snailclimb/JavaInterview')
    console.log('')
    console.log('环境变量:')
    console.log('  ANTHROPIC_API_KEY=your-api-key  或在 .env 文件中配置')
    return
  }

  // 1. 分析仓库
  const analysis = analyzeRepo(repoUrl)
  console.log(`📄 找到 ${Object.values(analysis.fileStats).reduce((a, b) => a + b, 0)} 个文件`)
  console.log(`📊 文件类型: ${Object.entries(analysis.fileStats).map(([ext, count]) => `${ext}(${count})`).join(', ')}`)
  console.log(`📋 抽样了 ${analysis.samples.length} 个文件`)

  // 2. AI 生成规则
  const aiResponse = await generateRule(analysis)

  // 3. 提取 JSON
  const jsonMatch = aiResponse.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    console.log('\n❌ AI 未能生成有效的规则 JSON')
    console.log('AI 响应:')
    console.log(aiResponse)
    return
  }

  let rule: any
  try {
    rule = JSON.parse(jsonMatch[0])
  } catch (e: any) {
    console.log('\n❌ 生成的 JSON 格式错误')
    console.log(e.message)
    console.log('\nAI 输出:')
    console.log(jsonMatch[0])
    return
  }

  // 4. 验证规则结构
  const requiredFields = ['name', 'source', 'target', 'mapping']
  const missing = requiredFields.filter(f => !rule[f])
  if (missing.length > 0) {
    console.log(`\n❌ 规则缺少必要字段: ${missing.join(', ')}`)
    console.log('\nAI 输出:')
    console.log(JSON.stringify(rule, null, 2))
    return
  }

  // 5. 保存规则文件
  const repoName = repoUrl.split('/').pop()?.replace('.git', '') || 'unknown'
  const rulePath = path.join(__dirname, 'rules', `auto-${repoName}.json`)
  fs.writeFileSync(rulePath, JSON.stringify(rule, null, 2), 'utf-8')

  console.log('\n✅ 分析完成!')
  console.log(`\n📦 仓库: ${repoUrl}`)
  console.log(`📁 规则文件: rules/auto-${repoName}.json`)
  console.log(`\n规则内容:`)
  console.log(JSON.stringify(rule, null, 2))
  console.log(`\n💡 执行清洗:`)
  console.log(`   npm run clean -- rules/auto-${repoName}.json`)
}

main().catch(console.error)
