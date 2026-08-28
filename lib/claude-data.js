import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'

const MAX_TRANSCRIPT_CHARS = 30000
const USER_LIMIT = 500
const ASSISTANT_LIMIT = 300

export function resolveClaudeHome(explicitHome) {
  return path.resolve(explicitHome || path.join(os.homedir(), '.claude'))
}

export async function collectClaudeThreadSummaries({ claudeHome, sinceEpochSeconds, limit }) {
  const projectsDir = path.join(claudeHome, 'projects')
  const files = await listJsonlFiles(projectsDir)
  const summaries = []

  for (const filePath of files) {
    const stat = await fs.stat(filePath)
    if (sinceEpochSeconds && stat.mtimeMs < sinceEpochSeconds * 1000) continue
    const summary = await summarizeClaudeSession(filePath)
    if (isSubstantiveClaudeSession(summary)) summaries.push(summary)
  }

  summaries.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
  return limit ? summaries.slice(0, Number(limit)) : summaries
}

async function listJsonlFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const filePath = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await listJsonlFiles(filePath)))
    if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(filePath)
  }
  return files
}

async function summarizeClaudeSession(filePath) {
  const raw = await fs.readFile(filePath, 'utf8')
  const events = raw.split('\n').flatMap(line => {
    try { return line.trim() ? [JSON.parse(line)] : [] } catch { return [] }
  })
  const seenMessageIds = new Set()
  const toolCounts = {}
  const toolFailures = {}
  const toolErrorCategories = {}
  const commandKindCounts = {}
  const activeHours = []
  const userMessageTimestamps = []
  const transcript = []
  const models = new Map()
  const filesModified = new Set()
  let firstUserMessage = ''
  let title = ''
  let cwd = ''
  let createdAt = null
  let updatedAt = null
  let userMessages = 0
  let assistantMessages = 0
  let reasoningItems = 0
  let toolErrors = 0
  let usesTaskAgent = false
  let usesMcp = false
  let usesWebSearch = false
  let usesWebFetch = false
  let linesAdded = 0
  let linesRemoved = 0
  let inputTokens = 0
  let cachedInputTokens = 0
  let outputTokens = 0

  for (const event of events) {
    const timestamp = Date.parse(event.timestamp)
    if (Number.isFinite(timestamp)) {
      createdAt = createdAt === null ? timestamp : Math.min(createdAt, timestamp)
      updatedAt = updatedAt === null ? timestamp : Math.max(updatedAt, timestamp)
    }
    cwd ||= String(event.cwd || '')
    title ||= String(event.aiTitle || '')
    const message = event.message
    const messageId = message?.id || event.uuid
    if (!message || !messageId || seenMessageIds.has(messageId)) continue
    seenMessageIds.add(messageId)
    const content = Array.isArray(message.content) ? message.content : []

    if (event.type === 'user' || message.role === 'user') {
      const text = extractText(content)
      if (text) {
        userMessages += 1
        firstUserMessage ||= text
        transcript.push(`[User] ${clean(text, USER_LIMIT)}`)
        if (Number.isFinite(timestamp)) {
          userMessageTimestamps.push(new Date(timestamp).toISOString())
          activeHours.push(new Date(timestamp).getHours())
        }
      }
      continue
    }
    if (event.type !== 'assistant' && message.role !== 'assistant') continue

    assistantMessages += 1
    const model = String(message.model || '')
    if (model && model !== '<synthetic>') models.set(model, (models.get(model) || 0) + 1)
    const usage = message.usage || {}
    inputTokens += Number(usage.input_tokens || 0)
    cachedInputTokens += Number(usage.cache_creation_input_tokens || 0) + Number(usage.cache_read_input_tokens || 0)
    outputTokens += Number(usage.output_tokens || 0)

    const text = extractText(content)
    if (text) transcript.push(`[Assistant] ${clean(text, ASSISTANT_LIMIT)}`)
    for (const part of content) {
      if (part?.type === 'thinking') reasoningItems += 1
      if (part?.type !== 'tool_use') continue
      const rawName = String(part.name || 'tool_use')
      const skillName = rawName === 'Skill' ? String(part.input?.skill || part.input?.name || 'Skill') : ''
      const name = skillName ? `Skill:${skillName}` : rawName
      toolCounts[name] = (toolCounts[name] || 0) + 1
      transcript.push(`[Tool: ${name}]`)
      if (rawName === 'Task' || rawName === 'Agent') usesTaskAgent = true
      if (/^mcp__/i.test(rawName)) usesMcp = true
      if (/websearch/i.test(rawName)) usesWebSearch = true
      if (/webfetch/i.test(rawName)) usesWebFetch = true
      if (rawName === 'Bash') commandKindCounts.Bash = (commandKindCounts.Bash || 0) + 1
      if (rawName === 'Write' || rawName === 'Edit' || rawName === 'NotebookEdit') {
        const file = part.input?.file_path || part.input?.path
        if (file) filesModified.add(String(file))
        if (rawName === 'Write') linesAdded += String(part.input?.content || '').split('\n').length
        if (rawName === 'Edit') {
          linesAdded += String(part.input?.new_string || '').split('\n').length
          linesRemoved += String(part.input?.old_string || '').split('\n').length
        }
      }
    }
  }

  const model = [...models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '(unknown model)'
  const started = createdAt ?? Date.now()
  const ended = updatedAt ?? started
  const totalTokens = inputTokens + cachedInputTokens + outputTokens
  return {
    id: path.basename(filePath, '.jsonl'), title: title || clean(firstUserMessage, 100) || path.basename(filePath),
    firstUserMessage: clean(firstUserMessage, 1200), cwd, model, modelProvider: 'claude-local',
    createdAt: new Date(started).toISOString(), updatedAt: new Date(ended).toISOString(),
    durationMinutes: Math.round(((ended - started) / 60000) * 10) / 10,
    userMessages, assistantMessages, commentaryMessages: 0, finalMessages: 0, reasoningItems,
    toolCounts, commandKindCounts, toolFailures,
    totalToolCalls: Object.values(toolCounts).reduce((sum, count) => sum + count, 0), totalCommandFailures: 0,
    commandFailures: [], commandSamples: [], averageCommandDurationMs: 0, medianResponseTimeSeconds: 0, averageResponseTimeSeconds: 0,
    activeHours, userMessageTimestamps, transcriptForAnalysis: clamp(transcript.join('\n')),
    gitCommits: 0, gitPushes: 0, userInterruptions: 0, toolErrors, toolErrorCategories,
    usesTaskAgent, usesMcp, usesWebSearch, usesWebFetch, linesAdded, linesRemoved, filesModified: filesModified.size,
    tokenUsage: { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens: 0, totalTokens },
  }
}

function isSubstantiveClaudeSession(summary) {
  return summary.userMessages >= 1 && Boolean(summary.transcriptForAnalysis.trim()) &&
    (summary.userMessages >= 2 || summary.totalToolCalls > 0 || summary.assistantMessages >= 3)
}

function extractText(content) {
  return content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n')
}

function clean(value, limit) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit)
}

function clamp(value) { return value.slice(0, MAX_TRANSCRIPT_CHARS) }
