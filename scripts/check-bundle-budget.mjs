import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const distDir = join(projectRoot, 'dist')
const manifestPath = join(distDir, '.vite', 'manifest.json')
const gzipMinBytes = 1024
const gzipLevel = 6

const budgets = {
  homeJs: 90 * 1024,
  mapJs: 110 * 1024,
  mapCss: 20 * 1024,
  analysisDetailJs: 15 * 1024,
  asyncJs: 55 * 1024,
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))

function requireEntry(key) {
  const entry = manifest[key]
  if (!entry) throw new Error(`Vite manifest entry not found: ${key}`)
  return entry
}

function staticClosure(entryKey) {
  requireEntry(entryKey)
  const keys = new Set()

  function visit(key) {
    if (keys.has(key)) return
    keys.add(key)
    const entry = requireEntry(key)
    for (const importedKey of entry.imports ?? []) visit(importedKey)
  }

  visit(entryKey)
  return keys
}

function difference(values, excluded) {
  return new Set([...values].filter((value) => !excluded.has(value)))
}

function jsFiles(entryKeys) {
  return new Set(
    [...entryKeys]
      .map((key) => requireEntry(key).file)
      .filter((file) => file.endsWith('.js')),
  )
}

function cssFiles(entryKeys) {
  return new Set(
    [...entryKeys].flatMap((key) => requireEntry(key).css ?? []),
  )
}

async function transferBytes(files) {
  let total = 0
  for (const file of files) {
    const content = await readFile(join(distDir, file))
    total += content.byteLength < gzipMinBytes
      ? content.byteLength
      : gzipSync(content, { level: gzipLevel }).byteLength
  }
  return total
}

function formatKib(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`
}

async function listJavaScriptFiles(directory, relativeDirectory = '') {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const relativePath = relativeDirectory
      ? `${relativeDirectory}/${entry.name}`
      : entry.name
    if (entry.isDirectory()) {
      files.push(...await listJavaScriptFiles(join(directory, entry.name), relativePath))
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(relativePath)
    }
  }

  return files
}

const homeGraph = staticClosure('index.html')
const mapGraph = staticClosure('src/pages/MapPage.tsx')
const detailGraph = staticClosure('src/components/AnalysisDetailPanel.tsx')
const addedMapGraph = difference(mapGraph, homeGraph)
const addedDetailGraph = difference(detailGraph, mapGraph)

const checks = [
  {
    label: 'Home entry JavaScript',
    actual: await transferBytes(jsFiles(homeGraph)),
    limit: budgets.homeJs,
  },
  {
    label: 'Additional map-route JavaScript',
    actual: await transferBytes(jsFiles(addedMapGraph)),
    limit: budgets.mapJs,
  },
  {
    label: 'Additional map-route CSS',
    actual: await transferBytes(cssFiles(addedMapGraph)),
    limit: budgets.mapCss,
  },
  {
    label: 'Analysis-detail JavaScript',
    actual: await transferBytes(jsFiles(addedDetailGraph)),
    limit: budgets.analysisDetailJs,
  },
]

const homeJsFiles = jsFiles(homeGraph)
const asyncFiles = (await listJavaScriptFiles(distDir))
  .filter((file) => !homeJsFiles.has(file))
  .sort()

for (const file of asyncFiles) {
  checks.push({
    label: `Async chunk ${file}`,
    actual: await transferBytes(new Set([file])),
    limit: budgets.asyncJs,
  })
}

let failed = false
for (const check of checks) {
  const passed = check.actual <= check.limit
  failed ||= !passed
  console.log(
    `${passed ? 'PASS' : 'FAIL'} ${check.label}: ${formatKib(check.actual)} / ${formatKib(check.limit)}`,
  )
}

if (failed) {
  console.error('Bundle budget exceeded. Split or remove code before increasing a limit.')
  process.exitCode = 1
}
