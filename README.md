# Java 成长助手 - 题库

Java 成长助手客户端的远程题库数据仓库。

客户端通过下载 zip 拉取本仓库最新题库，自动同步到本地 SQLite 数据库。

## 结构

```
interview/           # 面试宝典题库
assessment/          # 技能评估题库
scripts/
  clean.ts           # 数据清洗脚本
  generate-rule.ts   # AI 规则生成器
  rules/             # 清洗规则配置
    example-json.json
    example-markdown.json
    real-example.json
```

## 数据清洗工具

内置清洗工具，可以从开源仓库拉取数据，按规则清洗成我们的格式。

### 快速开始

```bash
# 安装依赖
npm install

# 清洗单个规则
npm run clean -- rules/example-json.json

# 清洗所有规则
npm run clean:all

# 清洗并自动提交推送
npm run clean:push
```

### 清洗规则格式

规则是一个 JSON 配置文件，放在 `scripts/rules/` 目录下：

```json
{
  "name": "规则名称",
  "description": "规则描述",
  "source": {
    "repo": "https://github.com/user/repo",
    "path": "data/questions/",
    "filePattern": "*.json",
    "format": "json"
  },
  "target": {
    "type": "interview",
    "outputDir": "interview",
    "filename": "output.json",
    "idPrefix": "ext-"
  },
  "mapping": {
    "question": { "source": "title" },
    "answer": { "source": "content" },
    "category": { "source": "fixed", "value": "java" },
    "difficulty": {
      "source": "map",
      "field": "level",
      "values": { "easy": "junior", "medium": "mid", "hard": "senior" }
    }
  },
  "filters": [
    { "field": "question", "minLength": 10 }
  ],
  "dedup": {
    "field": "question",
    "strategy": "keep-first"
  }
}
```

### 支持的源格式

| format | 说明 |
|--------|------|
| `json` | JSON 数组文件 |
| `jsonl` | 每行一个 JSON 对象 |
| `markdown` | Markdown 文件，按 `##` 标题分割成题目 |
| `yaml` | YAML 文件 |

### 字段映射规则

每个目标字段定义一个 mapping：

| source 类型 | 说明 | 示例 |
|-------------|------|------|
| 字段名 | 直接取源对象的字段 | `{ "source": "title" }` |
| `fixed` | 固定值 | `{ "source": "fixed", "value": "java" }` |
| `map` | 值映射 | `{ "source": "map", "field": "level", "values": {"easy": "junior"} }` |
| `extract` | 正则提取 | `{ "source": "extract", "field": "content", "pattern": "^[-•]\\s+(.+)$" }` |
| `expr` | 表达式拼接 | `{ "source": "expr", "expression": "title + ' - ' + desc" }` |

### 过滤规则

```json
[
  { "field": "question", "minLength": 10 },
  { "field": "answer", "contains": "Java" },
  { "field": "category", "in": ["java", "spring"] },
  { "field": "title", "regex": "^什么是" }
]
```

支持：`minLength`, `maxLength`, `contains`, `notContains`, `in`, `notIn`, `regex`

---

## AI 规则生成器

不想手写规则？让 AI 帮你分析仓库，自动生成清洗规则。

### 配置

```bash
# 复制环境变量模板
cp .env.example .env

# 编辑 .env，填入 Claude API Key
ANTHROPIC_API_KEY=your-api-key-here
```

API Key 从 https://console.anthropic.com/ 获取。

### 使用

```bash
# 分析仓库并生成规则
npm run generate -- https://github.com/Snailclimb/JavaInterview

# 生成的规则会保存到 rules/auto-{repo-name}.json
# 然后执行清洗
npm run clean -- rules/auto-JavaInterview.json
```

### 工作流程

```
输入 GitHub URL
  → 克隆仓库（浅克隆）
  → 扫描文件结构 + 抽样读取
  → Claude AI 分析数据格式
  → 判断能否清洗 + 生成规则 JSON
  → 保存到 rules/auto-xxx.json
  → 提示执行清洗命令
```

### 示例

```bash
$ npm run generate -- https://github.com/example/interview-questions

⬇️  克隆仓库: https://github.com/example/interview-questions
📄 找到 156 个文件
📊 文件类型: .json(12), .md(140), .txt(4)
📋 抽样了 4 个文件
🤖 正在分析仓库结构和数据格式...

✅ 分析完成!

📦 仓库: https://github.com/example/interview-questions
📁 规则文件: rules/auto-interview-questions.json

💡 执行清洗:
   npm run clean -- rules/auto-interview-questions.json
```

## 如何贡献

1. Fork 本仓库
2. 修改或新增 JSON 文件（保持格式一致）
3. 或者新增清洗规则，从开源仓库自动拉取
4. 提交 Pull Request

## 题目格式

### 面试题（interview/*.json）

```json
{
  "id": "ij-01",
  "category": "java",
  "difficulty": "junior",
  "question": "问题描述",
  "answer": "详细答案",
  "keyPoints": ["关键点1", "关键点2"],
  "followUp": ["追问1"]
}
```

category 可选值: `java`, `jvm`, `concurrency`, `spring`, `mysql`, `redis`, `distributed`, `systemDesign`, `network`, `devops`, `algorithm`, `project`, `behavioral`

difficulty 可选值: `junior`, `mid`, `senior`

### 评估题（assessment/*.json）

```json
{
  "id": "jb-01",
  "dimension": "javaBasics",
  "difficulty": "basic",
  "title": "题目描述",
  "options": [
    { "label": "选项A", "value": "a", "score": 1 },
    { "label": "选项B", "value": "b", "score": 4 }
  ],
  "answer": "b",
  "explanation": "解释为什么选B"
}
```

dimension 可选值: `javaBasics`, `jvm`, `concurrency`, `spring`, `database`, `architecture`

difficulty 可选值: `basic`, `intermediate`, `advanced`
