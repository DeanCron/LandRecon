#!/usr/bin/env node
/**
 * Build voting-district boundary files for the LandRecon "Voting districts"
 * layer.
 *
 * Source: U.S. Census Bureau Cartographic Boundary Files (2023 vintage).
 * Public domain.
 *
 * Output: public/data/districts/{cd118,sldu,sldl}.geojson
 *
 * Run with:  npm run build:districts
 */
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import mapshaper from 'mapshaper'

const CENSUS_BASE = 'https://www2.census.gov/geo/tiger/GENZ2023/shp'

const LAYERS = [
  {
    id: 'cd118',
    label: 'Congressional districts (118th)',
    zip: 'cb_2023_us_cd118_500k.zip',
    shp: 'cb_2023_us_cd118_500k.shp',
    keepFields: ['STATEFP', 'CD118FP', 'NAMELSAD', 'GEOID'],
  },
  {
    id: 'sldu',
    label: 'State Senate districts',
    zip: 'cb_2023_us_sldu_500k.zip',
    shp: 'cb_2023_us_sldu_500k.shp',
    keepFields: ['STATEFP', 'SLDUST', 'NAMELSAD', 'GEOID'],
  },
  {
    id: 'sldl',
    label: 'State House districts',
    zip: 'cb_2023_us_sldl_500k.zip',
    shp: 'cb_2023_us_sldl_500k.shp',
    keepFields: ['STATEFP', 'SLDLST', 'NAMELSAD', 'GEOID'],
  },
]

const OUT_DIR = join(process.cwd(), 'public', 'data', 'districts')
const WORK_DIR = join(tmpdir(), 'landrecon-districts')

async function download(url, dest) {
  process.stdout.write(`  fetch ${url} ... `)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  await writeFile(dest, buf)
  console.log(`${(buf.length / 1024 / 1024).toFixed(1)} MB`)
}

function unzip(zipPath, outDir) {
  const z = new AdmZip(zipPath)
  z.extractAllTo(outDir, true)
}

async function buildLayer(layer) {
  console.log(`\n[${layer.id}] ${layer.label}`)
  const zipPath = join(WORK_DIR, layer.zip)
  const shpDir = join(WORK_DIR, layer.id)
  const outPath = join(OUT_DIR, `${layer.id}.geojson`)

  await download(`${CENSUS_BASE}/${layer.zip}`, zipPath)
  await mkdir(shpDir, { recursive: true })
  unzip(zipPath, shpDir)

  const shpPath = join(shpDir, layer.shp)
  const fields = layer.keepFields.join(',')

  // -simplify 10% dp keep-shapes : Douglas-Peucker, retain small islands
  // -filter-fields                : drop noisy Census attributes we don't use
  // -proj wgs84                   : Leaflet expects lon/lat (EPSG:4326)
  // -o precision=0.00001          : ~1m, plenty for choropleth display
  const cmd =
    `-i "${shpPath}" ` +
    `-simplify 10% dp keep-shapes ` +
    `-filter-fields ${fields} ` +
    `-proj wgs84 ` +
    `-o format=geojson precision=0.00001 "${outPath}"`

  await mapshaper.runCommands(cmd)

  const { size } = await import('node:fs').then((m) =>
    new Promise((resolve, reject) =>
      m.stat(outPath, (err, s) => (err ? reject(err) : resolve(s))),
    ),
  )
  console.log(`  wrote ${outPath} (${(size / 1024 / 1024).toFixed(2)} MB)`)
}

async function main() {
  console.log('Building LandRecon voting-district boundary files')
  console.log(`  out: ${OUT_DIR}`)
  console.log(`  tmp: ${WORK_DIR}`)
  await mkdir(OUT_DIR, { recursive: true })
  if (existsSync(WORK_DIR)) await rm(WORK_DIR, { recursive: true, force: true })
  await mkdir(WORK_DIR, { recursive: true })

  for (const layer of LAYERS) {
    await buildLayer(layer)
  }

  await rm(WORK_DIR, { recursive: true, force: true })
  console.log('\nDone. Three GeoJSON files written to public/data/districts/.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
