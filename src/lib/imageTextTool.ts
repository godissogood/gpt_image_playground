import { loadImage } from './canvasImage'

export interface ImageTextBlock {
  id: string
  text: string
  replacementText: string
  bbox: { x: number; y: number; w: number; h: number }
  language?: string
  confidence?: number
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

export function normalizeImageTextBlocks(value: unknown): ImageTextBlock[] {
  if (!Array.isArray(value)) return []
  const blocks: ImageTextBlock[] = []
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index]
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const text = typeof record.text === 'string' ? record.text.trim() : ''
    if (!text) continue
    const bboxValue = record.bbox
    if (!bboxValue || typeof bboxValue !== 'object') continue
    const bboxRecord = bboxValue as Record<string, unknown>
    const x = typeof bboxRecord.x === 'number' ? bboxRecord.x : NaN
    const y = typeof bboxRecord.y === 'number' ? bboxRecord.y : NaN
    const w = typeof bboxRecord.w === 'number' ? bboxRecord.w : NaN
    const h = typeof bboxRecord.h === 'number' ? bboxRecord.h : NaN
    if (![x, y, w, h].every(Number.isFinite)) continue
    const normalized = {
      x: clamp(x, 0, 1),
      y: clamp(y, 0, 1),
      w: clamp(w, 0.02, 1),
      h: clamp(h, 0.02, 1),
    }
    if (normalized.x + normalized.w > 1) normalized.w = Math.max(0.02, 1 - normalized.x)
    if (normalized.y + normalized.h > 1) normalized.h = Math.max(0.02, 1 - normalized.y)
    blocks.push({
      id: typeof record.id === 'string' && record.id.trim() ? record.id.trim() : `text-block-${index + 1}`,
      text,
      replacementText: typeof record.replacementText === 'string' && record.replacementText.trim() ? record.replacementText : text,
      bbox: normalized,
      language: typeof record.language === 'string' ? record.language : undefined,
      confidence: typeof record.confidence === 'number' && Number.isFinite(record.confidence) ? record.confidence : undefined,
    })
  }
  return blocks
}

function sampleBackgroundColor(data: Uint8ClampedArray, width: number, height: number, left: number, top: number, right: number, bottom: number) {
  const samples: Array<[number, number, number]> = []
  const addSample = (x: number, y: number) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return
    const idx = (y * width + x) * 4
    samples.push([data[idx], data[idx + 1], data[idx + 2]])
  }
  const pad = 3
  for (let x = left - pad; x <= right + pad; x += 1) {
    addSample(x, top - pad)
    addSample(x, bottom + pad)
  }
  for (let y = top; y <= bottom; y += 1) {
    addSample(left - pad, y)
    addSample(right + pad, y)
  }
  if (samples.length === 0) return { fill: 'rgba(255,255,255,0.92)', text: '#111827' }
  const [r, g, b] = samples.reduce(
    (acc, sample) => [acc[0] + sample[0], acc[1] + sample[1], acc[2] + sample[2]],
    [0, 0, 0],
  ).map((sum) => Math.round(sum / samples.length))
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return {
    fill: `rgba(${r}, ${g}, ${b}, 0.92)`,
    text: luminance > 150 ? '#111827' : '#f9fafb',
  }
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number) {
  const paragraphs = text.split(/\n+/)
  const lines: string[] = []
  for (const paragraph of paragraphs) {
    const units = /\s/.test(paragraph) ? paragraph.split(/\s+/) : Array.from(paragraph)
    let current = ''
    for (const unit of units) {
      const next = current ? (/\s/.test(paragraph) ? `${current} ${unit}` : `${current}${unit}`) : unit
      if (ctx.measureText(next).width <= maxWidth || !current) {
        current = next
      } else {
        lines.push(current)
        current = unit
      }
    }
    if (current) lines.push(current)
  }
  return lines.length > 0 ? lines : ['']
}

function fitFont(ctx: CanvasRenderingContext2D, text: string, boxWidth: number, boxHeight: number) {
  const padding = 6
  for (let fontSize = Math.max(12, Math.floor(boxHeight * 0.6)); fontSize >= 10; fontSize -= 1) {
    ctx.font = `600 ${fontSize}px sans-serif`
    const lineHeight = fontSize * 1.2
    const lines = wrapText(ctx, text, Math.max(10, boxWidth - padding * 2))
    const fitsHeight = lines.length * lineHeight <= boxHeight - padding * 2
    if (fitsHeight) return { fontSize, lines, lineHeight, padding }
  }
  ctx.font = '600 10px sans-serif'
  return {
    fontSize: 10,
    lines: wrapText(ctx, text, Math.max(10, boxWidth - padding * 2)),
    lineHeight: 12,
    padding,
  }
}

export async function renderImageTextBlocks(imageDataUrl: string, blocks: ImageTextBlock[]) {
  const image = await loadImage(imageDataUrl)
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('当前浏览器不支持 Canvas')
  ctx.drawImage(image, 0, 0)
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height)

  for (const block of blocks) {
    const replacement = block.replacementText.trim()
    if (!replacement) continue
    const left = Math.round(block.bbox.x * canvas.width)
    const top = Math.round(block.bbox.y * canvas.height)
    const boxWidth = Math.max(20, Math.round(block.bbox.w * canvas.width))
    const boxHeight = Math.max(20, Math.round(block.bbox.h * canvas.height))
    const right = left + boxWidth - 1
    const bottom = top + boxHeight - 1
    const colors = sampleBackgroundColor(pixels.data, canvas.width, canvas.height, left, top, right, bottom)

    ctx.fillStyle = colors.fill
    ctx.fillRect(left, top, boxWidth, boxHeight)
    ctx.textBaseline = 'top'
    ctx.fillStyle = colors.text
    const layout = fitFont(ctx, replacement, boxWidth, boxHeight)
    ctx.font = `600 ${layout.fontSize}px sans-serif`
    layout.lines.forEach((line, index) => {
      ctx.fillText(line, left + layout.padding, top + layout.padding + index * layout.lineHeight)
    })
  }

  return canvas.toDataURL('image/png')
}
