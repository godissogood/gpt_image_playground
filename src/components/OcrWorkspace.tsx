import { useEffect, useMemo, useRef, useState } from 'react'
import { createInputImageFromFile, useStore } from '../store'
import { DEFAULT_PARAMS, type InputImage, type OcrTextBlock, type TaskRecord } from '../types'
import { getAssistantApiProfile, getImageApiProfile, normalizeSettings, validateApiProfile } from '../lib/apiProfiles'
import { loadImage } from '../lib/canvasImage'
import { callImageApi } from '../lib/api'
import { callImageOcrApi, callTranslateTextBlocksApi } from '../lib/agentApi'
import { downloadImageEntriesAsZip, formatExportFileTime, getImageZipEntries } from '../lib/downloadImages'
import { normalizeImageTextBlocks, renderImageTextBlocks } from '../lib/imageTextTool'
import { putTask, storeImage } from '../lib/db'
import { CloseIcon, CodeIcon, DownloadIcon, EditIcon, PlusIcon, RefreshIcon } from './icons'

type DraftBlock = OcrTextBlock & { selected?: boolean }
type RepairPreset = 'none' | 'light' | 'clean' | 'creative'

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function createBlockId() {
  return `ocr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function createTaskId() {
  return `ocr-task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function detectOutputFormat(dataUrl: string): 'png' | 'jpeg' | 'webp' {
  if (dataUrl.startsWith('data:image/jpeg')) return 'jpeg'
  if (dataUrl.startsWith('data:image/webp')) return 'webp'
  return 'png'
}

function createEmptyBlock(): DraftBlock {
  return {
    id: createBlockId(),
    text: '',
    replacementText: '',
    bbox: { x: 0.2, y: 0.2, w: 0.2, h: 0.08 },
    selected: false,
  }
}

function buildRepairPrompt(blocks: DraftBlock[], preset: RepairPreset) {
  const lines = blocks
    .filter((block) => block.replacementText.trim())
    .map((block, index) => `${index + 1}. replace "${block.text || '[empty]'}" with "${block.replacementText.trim()}"`)

  const repairStyle = preset === 'light'
    ? 'Keep the original layout and only repair the text area very lightly.'
    : preset === 'clean'
    ? 'Cleanly repair the covered background so the final result looks natural and cohesive.'
    : preset === 'creative'
    ? 'Repair the covered background naturally and blend typography and surrounding details more creatively while keeping the original composition.'
    : 'Keep the original composition and replace the text faithfully.'

  return [
    'You are editing an existing image.',
    'Replace the visible text regions with the requested new text while preserving the original composition, objects, perspective, and lighting.',
    repairStyle,
    'Do not add extra posters, frames, duplicated text, or unrelated elements.',
    lines.length > 0 ? `Requested replacements:\n${lines.join('\n')}` : 'No specific replacement text was provided; only clean the selected text regions.',
  ].join('\n')
}

export default function OcrWorkspace() {
  const settings = useStore((s) => s.settings)
  const params = useStore((s) => s.params)
  const galleryMode = useStore((s) => s.galleryMode)
  const ocrImage = useStore((s) => s.ocrImage)
  const ocrImages = useStore((s) => s.ocrImages)
  const setOcrImage = useStore((s) => s.setOcrImage)
  const setOcrImages = useStore((s) => s.setOcrImages)
  const addOcrImages = useStore((s) => s.addOcrImages)
  const removeOcrImage = useStore((s) => s.removeOcrImage)
  const setGalleryMode = useStore((s) => s.setGalleryMode)
  const setInputImages = useStore((s) => s.setInputImages)
  const setMaskDraft = useStore((s) => s.setMaskDraft)
  const setMaskEditorImageId = useStore((s) => s.setMaskEditorImageId)
  const setPrompt = useStore((s) => s.setPrompt)
  const setAppMode = useStore((s) => s.setAppMode)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const setLightboxImageId = useStore((s) => s.setLightboxImageId)
  const setTasks = useStore((s) => s.setTasks)
  const showToast = useStore((s) => s.showToast)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const batchFileInputRef = useRef<HTMLInputElement>(null)
  const imagePaneRef = useRef<HTMLDivElement>(null)
  const dragStateRef = useRef<{
    pointerId: number
    mode: 'create' | 'move' | 'resize'
    blockId: string
    handle?: string
    startX: number
    startY: number
    startBox: DraftBlock['bbox']
    imageRect: DOMRect
  } | null>(null)

  const [blocksByImageId, setBlocksByImageId] = useState<Record<string, DraftBlock[]>>({})
  const [previewByImageId, setPreviewByImageId] = useState<Record<string, string>>({})
  const [renderedByImageId, setRenderedByImageId] = useState<Record<string, string>>({})
  const [ocrLoadingIds, setOcrLoadingIds] = useState<Record<string, true>>({})
  const [translateLoadingIds, setTranslateLoadingIds] = useState<Record<string, true>>({})
  const [renderLoadingIds, setRenderLoadingIds] = useState<Record<string, true>>({})
  const [repairLoadingIds, setRepairLoadingIds] = useState<Record<string, true>>({})
  const [batchTranslateLoading, setBatchTranslateLoading] = useState(false)
  const [batchRenderLoading, setBatchRenderLoading] = useState(false)
  const [batchRepairLoading, setBatchRepairLoading] = useState(false)
  const [repairPresetByImageId, setRepairPresetByImageId] = useState<Record<string, RepairPreset>>({})
  const [batchProgress, setBatchProgress] = useState<{ total: number; done: number; failed: number } | null>(null)

  const activeImageId = ocrImage?.id ?? null
  const blocks = useMemo(() => (activeImageId ? blocksByImageId[activeImageId] ?? [] : []), [activeImageId, blocksByImageId])
  const currentPreview = activeImageId ? previewByImageId[activeImageId] ?? renderedByImageId[activeImageId] ?? ocrImage?.dataUrl ?? '' : ''
  const currentRepairPreset = activeImageId ? repairPresetByImageId[activeImageId] ?? 'clean' : 'clean'

  useEffect(() => {
    if (galleryMode !== 'ocr') return
    if (!ocrImage && ocrImages.length > 0) setOcrImage(ocrImages[0] ?? null)
  }, [galleryMode, ocrImage, ocrImages, setOcrImage])

  const updateBlocks = (imageId: string, updater: (prev: DraftBlock[]) => DraftBlock[]) => {
    setBlocksByImageId((prev) => ({ ...prev, [imageId]: updater(prev[imageId] ?? []) }))
  }

  const setLoadingFlag = (
    setter: React.Dispatch<React.SetStateAction<Record<string, true>>>,
    imageId: string,
    loading: boolean,
  ) => {
    setter((prev) => {
      if (loading) return { ...prev, [imageId]: true }
      const next = { ...prev }
      delete next[imageId]
      return next
    })
  }

  const getBlocks = (imageId: string) => blocksByImageId[imageId] ?? []
  const getResultDataUrl = (image: InputImage) => previewByImageId[image.id] ?? renderedByImageId[image.id] ?? image.dataUrl

  const ensureAssistantProfile = () => {
    const profile = getAssistantApiProfile(settings)
    const validation = validateApiProfile(profile)
    if (validation) {
      showToast(`请先完善辅助接口配置：${validation}`, 'error')
      setShowSettings(true, 'agent')
      return null
    }
    return profile
  }

  const ensureImageProfile = () => {
    const profile = getImageApiProfile(settings)
    const validation = validateApiProfile(profile)
    if (validation) {
      showToast(`请先完善图片接口配置：${validation}`, 'error')
      setShowSettings(true, 'api')
      return null
    }
    return profile
  }

  const buildMaskDataUrl = async (image: InputImage, imageBlocks: DraftBlock[]) => {
    const sourceImage = await loadImage(image.dataUrl)
    const canvas = document.createElement('canvas')
    canvas.width = sourceImage.naturalWidth
    canvas.height = sourceImage.naturalHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('当前浏览器不支持 Canvas')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.globalCompositeOperation = 'destination-out'
    for (const block of imageBlocks) {
      const x = Math.round(block.bbox.x * canvas.width)
      const y = Math.round(block.bbox.y * canvas.height)
      const w = Math.max(8, Math.round(block.bbox.w * canvas.width))
      const h = Math.max(8, Math.round(block.bbox.h * canvas.height))
      ctx.fillRect(x, y, w, h)
    }
    ctx.globalCompositeOperation = 'source-over'
    return canvas.toDataURL('image/png')
  }

  const prepareSingleGalleryImageFromOcrResult = async (image: InputImage) => {
    const resultDataUrl = getResultDataUrl(image)
    if (!resultDataUrl) return null
    if (resultDataUrl === image.dataUrl) return image
    const imageId = await storeImage(resultDataUrl, 'generated')
    return { id: imageId, dataUrl: resultDataUrl }
  }

  const saveResultToGalleryHistory = async (image: InputImage, resultDataUrl: string, title: string) => {
    const outputImageId = await storeImage(resultDataUrl, 'generated')
    const imageMeta = await loadImage(resultDataUrl)
    const outputFormat = detectOutputFormat(resultDataUrl)
    const actualParams = {
      size: `${imageMeta.naturalWidth}x${imageMeta.naturalHeight}`,
      output_format: outputFormat,
      n: 1,
    }
    const now = Date.now()
    const task: TaskRecord = {
      id: createTaskId(),
      prompt: title,
      params: {
        ...DEFAULT_PARAMS,
        ...params,
        size: `${imageMeta.naturalWidth}x${imageMeta.naturalHeight}`,
        output_format: outputFormat,
        n: 1,
        transparent_output: false,
      },
      inputImageIds: [image.id],
      outputImages: [outputImageId],
      actualParams,
      actualParamsByImage: { [outputImageId]: actualParams },
      status: 'done',
      error: null,
      createdAt: now,
      finishedAt: now,
      elapsed: 0,
      sourceMode: 'gallery',
      apiProfileName: 'OCR 模式',
      apiModel: title,
    }
    setTasks([task, ...useStore.getState().tasks])
    await putTask(task)
    return task
  }

  const handleFiles = async (files: FileList | null, append = true) => {
    if (!files?.length) return
    const images: InputImage[] = []
    for (const file of Array.from(files)) {
      const image = await createInputImageFromFile(file)
      if (image) images.push(image)
    }
    if (images.length === 0) {
      showToast('没有读到可用图片', 'error')
      return
    }
    if (append) addOcrImages(images)
    else setOcrImages(images)
    setOcrImage(images[0] ?? null)
    showToast(images.length > 1 ? `已导入 ${images.length} 张待识别图片` : '图片已导入 OCR 模式', 'success')
  }

  const runOcrForImage = async (image: InputImage) => {
    const profile = ensureAssistantProfile()
    if (!profile) return
    setLoadingFlag(setOcrLoadingIds, image.id, true)
    try {
      const result = await callImageOcrApi({ settings, profile, imageDataUrl: image.dataUrl })
      const normalized = normalizeImageTextBlocks(result).map((block) => ({ ...block, selected: false }))
      setBlocksByImageId((prev) => ({ ...prev, [image.id]: normalized }))
      setPreviewByImageId((prev) => ({ ...prev, [image.id]: image.dataUrl }))
      showToast(normalized.length > 0 ? `识别完成：${normalized.length} 个文本块` : '未识别到可处理文字', normalized.length > 0 ? 'success' : 'info')
    } catch (error) {
      showToast(`识别文字失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    } finally {
      setLoadingFlag(setOcrLoadingIds, image.id, false)
    }
  }

  const runBatchOcr = async () => {
    if (ocrImages.length === 0) {
      showToast('请先导入图片', 'info')
      return
    }
    const profile = ensureAssistantProfile()
    if (!profile) return
    setBatchProgress({ total: ocrImages.length, done: 0, failed: 0 })
    let done = 0
    let failed = 0
    for (const image of ocrImages) {
      setLoadingFlag(setOcrLoadingIds, image.id, true)
      try {
        const result = await callImageOcrApi({ settings, profile, imageDataUrl: image.dataUrl })
        const normalized = normalizeImageTextBlocks(result).map((block) => ({ ...block, selected: false }))
        setBlocksByImageId((prev) => ({ ...prev, [image.id]: normalized }))
        setPreviewByImageId((prev) => ({ ...prev, [image.id]: image.dataUrl }))
        done += 1
      } catch {
        failed += 1
      } finally {
        setLoadingFlag(setOcrLoadingIds, image.id, false)
        setBatchProgress({ total: ocrImages.length, done, failed })
      }
    }
    showToast(failed > 0 ? `批量识别完成：成功 ${done}，失败 ${failed}` : `批量识别完成：${done} 张`, failed > 0 ? 'error' : 'success')
  }

  const handleTranslateAll = async () => {
    if (!activeImageId || blocks.length === 0) {
      showToast('请先识别文字', 'info')
      return
    }
    const profile = ensureAssistantProfile()
    if (!profile) return
    setLoadingFlag(setTranslateLoadingIds, activeImageId, true)
    try {
      const translations = await callTranslateTextBlocksApi({
        settings,
        profile,
        texts: blocks.map((block) => block.text),
        targetLanguage: 'zh',
      })
      updateBlocks(activeImageId, (prev) => prev.map((block, index) => ({
        ...block,
        replacementText: translations[index] ?? block.replacementText,
      })))
      showToast('翻译完成', 'success')
    } catch (error) {
      showToast(`翻译失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    } finally {
      setLoadingFlag(setTranslateLoadingIds, activeImageId, false)
    }
  }

  const handleBatchTranslate = async () => {
    if (ocrImages.length === 0) {
      showToast('请先导入图片', 'info')
      return
    }
    const profile = ensureAssistantProfile()
    if (!profile) return
    setBatchTranslateLoading(true)
    let done = 0
    let failed = 0
    let skipped = 0
    try {
      for (const image of ocrImages) {
        const imageBlocks = getBlocks(image.id)
        if (imageBlocks.length === 0) {
          skipped += 1
          continue
        }
        setLoadingFlag(setTranslateLoadingIds, image.id, true)
        try {
          const translations = await callTranslateTextBlocksApi({
            settings,
            profile,
            texts: imageBlocks.map((block) => block.text),
            targetLanguage: 'zh',
          })
          updateBlocks(image.id, (prev) => prev.map((block, index) => ({
            ...block,
            replacementText: translations[index] ?? block.replacementText,
          })))
          done += 1
        } catch {
          failed += 1
        } finally {
          setLoadingFlag(setTranslateLoadingIds, image.id, false)
        }
      }
      showToast(`批量翻译完成：成功 ${done}${failed ? `，失败 ${failed}` : ''}${skipped ? `，跳过 ${skipped}` : ''}`, failed > 0 ? 'error' : 'success')
    } finally {
      setBatchTranslateLoading(false)
    }
  }

  const handleRenderOverlay = async (targetImage?: InputImage | null) => {
    const image = targetImage ?? ocrImage
    if (!image) {
      showToast('当前没有可处理图片', 'info')
      return
    }
    const imageBlocks = getBlocks(image.id)
    if (imageBlocks.length === 0) {
      showToast('请先识别或框选文字区域', 'info')
      return
    }
    setLoadingFlag(setRenderLoadingIds, image.id, true)
    try {
      const rendered = await renderImageTextBlocks(image.dataUrl, imageBlocks)
      setRenderedByImageId((prev) => ({ ...prev, [image.id]: rendered }))
      setPreviewByImageId((prev) => ({ ...prev, [image.id]: rendered }))
      const imageId = await storeImage(rendered, 'generated')
      setLightboxImageId(imageId, [imageId])
      showToast('已生成覆盖替换预览图', 'success')
    } catch (error) {
      showToast(`生成预览失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    } finally {
      setLoadingFlag(setRenderLoadingIds, image.id, false)
    }
  }

  const handleBatchRender = async () => {
    if (ocrImages.length === 0) {
      showToast('请先导入图片', 'info')
      return
    }
    setBatchRenderLoading(true)
    let done = 0
    let failed = 0
    let skipped = 0
    try {
      for (const image of ocrImages) {
        const imageBlocks = getBlocks(image.id)
        if (imageBlocks.length === 0) {
          skipped += 1
          continue
        }
        setLoadingFlag(setRenderLoadingIds, image.id, true)
        try {
          const rendered = await renderImageTextBlocks(image.dataUrl, imageBlocks)
          setRenderedByImageId((prev) => ({ ...prev, [image.id]: rendered }))
          setPreviewByImageId((prev) => ({ ...prev, [image.id]: rendered }))
          done += 1
        } catch {
          failed += 1
        } finally {
          setLoadingFlag(setRenderLoadingIds, image.id, false)
        }
      }
      showToast(`批量覆盖完成：成功 ${done}${failed ? `，失败 ${failed}` : ''}${skipped ? `，跳过 ${skipped}` : ''}`, failed > 0 ? 'error' : 'success')
    } finally {
      setBatchRenderLoading(false)
    }
  }

  const handleAiRepair = async () => {
    if (!ocrImage || blocks.length === 0) {
      showToast('请先识别或框选文字区域', 'info')
      return
    }
    const profile = ensureImageProfile()
    if (!profile) return
    setLoadingFlag(setRepairLoadingIds, ocrImage.id, true)
    try {
      const overlayPreview = await renderImageTextBlocks(ocrImage.dataUrl, blocks)
      const maskDataUrl = await buildMaskDataUrl(ocrImage, blocks)
      const result = await callImageApi({
        settings: normalizeSettings({ ...settings, activeProfileId: profile.id }),
        prompt: buildRepairPrompt(blocks, currentRepairPreset),
        params: { ...params, n: 1 },
        inputImageDataUrls: [overlayPreview],
        maskDataUrl,
      })
      const imageDataUrl = result.images[0]
      if (!imageDataUrl) throw new Error('接口没有返回修补后的图片')
      setPreviewByImageId((prev) => ({ ...prev, [ocrImage.id]: imageDataUrl }))
      setRenderedByImageId((prev) => ({ ...prev, [ocrImage.id]: imageDataUrl }))
      const imageId = await storeImage(imageDataUrl, 'generated')
      setLightboxImageId(imageId, [imageId])
      showToast('AI 修补背景完成', 'success')
    } catch (error) {
      showToast(`AI 修补失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    } finally {
      setLoadingFlag(setRepairLoadingIds, ocrImage.id, false)
    }
  }

  const handleBatchAiRepair = async () => {
    if (ocrImages.length === 0) {
      showToast('请先导入图片', 'info')
      return
    }
    const profile = ensureImageProfile()
    if (!profile) return
    setBatchRepairLoading(true)
    let done = 0
    let failed = 0
    let skipped = 0
    try {
      for (const image of ocrImages) {
        const imageBlocks = getBlocks(image.id)
        if (imageBlocks.length === 0) {
          skipped += 1
          continue
        }
        setLoadingFlag(setRepairLoadingIds, image.id, true)
        try {
          const overlayPreview = await renderImageTextBlocks(image.dataUrl, imageBlocks)
          const maskDataUrl = await buildMaskDataUrl(image, imageBlocks)
          const result = await callImageApi({
            settings: normalizeSettings({ ...settings, activeProfileId: profile.id }),
            prompt: buildRepairPrompt(imageBlocks, repairPresetByImageId[image.id] ?? 'clean'),
            params: { ...params, n: 1 },
            inputImageDataUrls: [overlayPreview],
            maskDataUrl,
          })
          const imageDataUrl = result.images[0]
          if (!imageDataUrl) throw new Error('接口没有返回修补后的图片')
          setPreviewByImageId((prev) => ({ ...prev, [image.id]: imageDataUrl }))
          setRenderedByImageId((prev) => ({ ...prev, [image.id]: imageDataUrl }))
          done += 1
        } catch {
          failed += 1
        } finally {
          setLoadingFlag(setRepairLoadingIds, image.id, false)
        }
      }
      showToast(`批量 AI 修补完成：成功 ${done}${failed ? `，失败 ${failed}` : ''}${skipped ? `，跳过 ${skipped}` : ''}`, failed > 0 ? 'error' : 'success')
    } finally {
      setBatchRepairLoading(false)
    }
  }

  const handleSaveCurrentResultToGallery = async () => {
    if (!ocrImage) {
      showToast('当前没有可保存图片', 'info')
      return
    }
    const resultDataUrl = renderedByImageId[ocrImage.id]
    if (!resultDataUrl) {
      showToast('请先生成覆盖替换或 AI 修补结果', 'info')
      return
    }
    const task = await saveResultToGalleryHistory(ocrImage, resultDataUrl, 'OCR 单图处理结果')
    showToast('已保存到画廊历史', 'success')
    setLightboxImageId(task.outputImages[0] ?? null, task.outputImages)
  }

  const handleSaveBatchResultsToGallery = async () => {
    const candidates = ocrImages.filter((image) => Boolean(renderedByImageId[image.id]))
    if (candidates.length === 0) {
      showToast('请先生成可保存的 OCR 结果', 'info')
      return
    }
    let saved = 0
    for (const image of candidates) {
      const resultDataUrl = renderedByImageId[image.id]
      if (!resultDataUrl) continue
      await saveResultToGalleryHistory(image, resultDataUrl, 'OCR 批量处理结果')
      saved += 1
    }
    showToast(saved > 1 ? `已保存 ${saved} 条结果到画廊历史` : '已保存到画廊历史', 'success')
  }

  const handleDownloadBatchResults = async () => {
    const resultImages = ocrImages
      .map((image) => ({ image, result: getResultDataUrl(image) }))
      .filter((item) => item.result)
    if (resultImages.length === 0) {
      showToast('当前没有可下载结果', 'info')
      return
    }

    const entries = []
    for (let index = 0; index < resultImages.length; index += 1) {
      const item = resultImages[index]
      const imageId = await storeImage(item.result, 'generated')
      entries.push(...getImageZipEntries([imageId], `ocr-${String(index + 1).padStart(2, '0')}`))
    }

    const fileNameBase = `ocr-batch-${formatExportFileTime(new Date())}`
    const result = await downloadImageEntriesAsZip(entries, fileNameBase)
    if (result.successCount === 0) showToast('下载失败', 'error')
    else if (result.failCount > 0) showToast(`部分下载失败：成功 ${result.successCount}，失败 ${result.failCount}`, 'error')
    else showToast(result.successCount > 1 ? `下载成功：${result.successCount} 张图片` : '下载成功', 'success')
  }

  const activateImageToImage = () => {
    if (!ocrImage) {
      showToast('请先选择一张图片', 'info')
      return
    }
    void (async () => {
      const image = await prepareSingleGalleryImageFromOcrResult(ocrImage)
      if (!image) {
        showToast('当前没有可回流的图片', 'info')
        return
      }
      setAppMode('gallery')
      setGalleryMode('generate')
      setInputImages([image])
      showToast('已送回图生图，可继续编辑', 'success')
    })()
  }

  const activateBatchImageToImage = async () => {
    if (ocrImages.length === 0) {
      showToast('请先导入图片', 'info')
      return
    }
    const prepared = await Promise.all(ocrImages.map((image) => prepareSingleGalleryImageFromOcrResult(image)))
    const images = prepared.filter((image): image is InputImage => Boolean(image)).slice(0, 16)
    if (images.length === 0) {
      showToast('当前没有可回流的图片', 'info')
      return
    }
    setAppMode('gallery')
    setGalleryMode('generate')
    setInputImages(images)
    showToast(images.length > 1 ? `已送回 ${images.length} 张图片到图生图` : '已送回图生图', 'success')
  }

  const activateMaskEdit = async () => {
    if (!ocrImage || blocks.length === 0) {
      showToast('请先识别或框选文字区域', 'info')
      return
    }
    const image = await prepareSingleGalleryImageFromOcrResult(ocrImage)
    if (!image) {
      showToast('当前没有可回流的图片', 'info')
      return
    }
    const maskDataUrl = await buildMaskDataUrl(ocrImage, blocks)
    setAppMode('gallery')
    setGalleryMode('generate')
    setInputImages([image])
    setMaskDraft({
      targetImageId: image.id,
      maskDataUrl,
      updatedAt: Date.now(),
    })
    setMaskEditorImageId(image.id)
    setPrompt(buildRepairPrompt(blocks, 'clean'))
    showToast('已送入局部重绘', 'success')
  }

  const updateBlock = (blockId: string, patch: Partial<DraftBlock>) => {
    if (!activeImageId) return
    updateBlocks(activeImageId, (prev) => prev.map((block) => block.id === blockId ? { ...block, ...patch } : block))
  }

  const addBlock = () => {
    if (!activeImageId) return
    updateBlocks(activeImageId, (prev) => [...prev.map((block) => ({ ...block, selected: false })), { ...createEmptyBlock(), selected: true }])
  }

  const deleteSelectedBlocks = () => {
    if (!activeImageId) return
    updateBlocks(activeImageId, (prev) => prev.filter((block) => !block.selected))
  }

  const clearBlocks = () => {
    if (!activeImageId) return
    updateBlocks(activeImageId, () => [])
  }

  const selectSingleBlock = (blockId: string) => {
    if (!activeImageId) return
    updateBlocks(activeImageId, (prev) => prev.map((block) => ({ ...block, selected: block.id === blockId })))
  }

  const toggleBlockSelection = (blockId: string) => {
    if (!activeImageId) return
    updateBlocks(activeImageId, (prev) => prev.map((block) => block.id === blockId ? { ...block, selected: !block.selected } : block))
  }

  const onCanvasPointerDown = (event: React.PointerEvent<HTMLElement>, blockId?: string, handle?: string) => {
    if (!activeImageId || !imagePaneRef.current) return
    const imageRect = imagePaneRef.current.getBoundingClientRect()
    const block = getBlocks(activeImageId).find((item) => item.id === blockId)

    if (blockId && block) {
      if (event.shiftKey) toggleBlockSelection(blockId)
      else selectSingleBlock(blockId)
      dragStateRef.current = {
        pointerId: event.pointerId,
        mode: handle ? 'resize' : 'move',
        blockId,
        handle,
        startX: event.clientX,
        startY: event.clientY,
        startBox: { ...block.bbox },
        imageRect,
      }
      ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
      return
    }

    const startX = clamp((event.clientX - imageRect.left) / imageRect.width, 0, 1)
    const startY = clamp((event.clientY - imageRect.top) / imageRect.height, 0, 1)
    const blockDraft: DraftBlock = {
      ...createEmptyBlock(),
      bbox: { x: startX, y: startY, w: 0.001, h: 0.001 },
      selected: true,
    }
    updateBlocks(activeImageId, (prev) => [...prev.map((item) => ({ ...item, selected: false })), blockDraft])
    dragStateRef.current = {
      pointerId: event.pointerId,
      mode: 'create',
      blockId: blockDraft.id,
      startX: event.clientX,
      startY: event.clientY,
      startBox: { ...blockDraft.bbox },
      imageRect,
    }
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  }

  const onCanvasPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const drag = dragStateRef.current
    if (!drag || !activeImageId) return
    const dx = (event.clientX - drag.startX) / drag.imageRect.width
    const dy = (event.clientY - drag.startY) / drag.imageRect.height
    updateBlocks(activeImageId, (prev) => prev.map((block) => {
      if (block.id !== drag.blockId) return block
      if (drag.mode === 'create') {
        const x = Math.min(drag.startBox.x, drag.startBox.x + dx)
        const y = Math.min(drag.startBox.y, drag.startBox.y + dy)
        return {
          ...block,
          bbox: {
            x: clamp(x, 0, 0.98),
            y: clamp(y, 0, 0.98),
            w: clamp(Math.abs(dx), 0.02, 1),
            h: clamp(Math.abs(dy), 0.02, 1),
          },
        }
      }
      if (drag.mode === 'move') {
        return {
          ...block,
          bbox: {
            ...block.bbox,
            x: clamp(drag.startBox.x + dx, 0, 1 - drag.startBox.w),
            y: clamp(drag.startBox.y + dy, 0, 1 - drag.startBox.h),
          },
        }
      }

      const next = { ...drag.startBox }
      switch (drag.handle) {
        case 'n':
          next.y = clamp(next.y + dy, 0, next.y + next.h - 0.02)
          next.h = clamp(drag.startBox.h - (next.y - drag.startBox.y), 0.02, 1)
          break
        case 's':
          next.h = clamp(next.h + dy, 0.02, 1 - next.y)
          break
        case 'w':
          next.x = clamp(next.x + dx, 0, next.x + next.w - 0.02)
          next.w = clamp(drag.startBox.w - (next.x - drag.startBox.x), 0.02, 1)
          break
        case 'e':
          next.w = clamp(next.w + dx, 0.02, 1 - next.x)
          break
        case 'nw':
          next.x = clamp(next.x + dx, 0, next.x + next.w - 0.02)
          next.y = clamp(next.y + dy, 0, next.y + next.h - 0.02)
          next.w = clamp(drag.startBox.w - (next.x - drag.startBox.x), 0.02, 1)
          next.h = clamp(drag.startBox.h - (next.y - drag.startBox.y), 0.02, 1)
          break
        case 'ne':
          next.y = clamp(next.y + dy, 0, next.y + next.h - 0.02)
          next.w = clamp(next.w + dx, 0.02, 1 - next.x)
          next.h = clamp(drag.startBox.h - (next.y - drag.startBox.y), 0.02, 1)
          break
        case 'sw':
          next.x = clamp(next.x + dx, 0, next.x + next.w - 0.02)
          next.w = clamp(drag.startBox.w - (next.x - drag.startBox.x), 0.02, 1)
          next.h = clamp(next.h + dy, 0.02, 1 - next.y)
          break
        case 'se':
        default:
          next.w = clamp(next.w + dx, 0.02, 1 - next.x)
          next.h = clamp(next.h + dy, 0.02, 1 - next.y)
      }
      return { ...block, bbox: next }
    }))
  }

  const onCanvasPointerUp = (event: React.PointerEvent<HTMLElement>) => {
    const drag = dragStateRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragStateRef.current = null
    ;(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId)
  }

  useEffect(() => {
    if (galleryMode !== 'ocr' || !activeImageId) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (!blocks.some((block) => block.selected)) return
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return
      if (event.target instanceof HTMLElement && ['INPUT', 'TEXTAREA'].includes(event.target.tagName)) return
      event.preventDefault()
      const step = event.shiftKey ? 0.01 : 0.005
      updateBlocks(activeImageId, (prev) => prev.map((block) => {
        if (!block.selected) return block
        const next = { ...block.bbox }
        if (event.key === 'ArrowUp') next.y = clamp(next.y - step, 0, 1 - next.h)
        if (event.key === 'ArrowDown') next.y = clamp(next.y + step, 0, 1 - next.h)
        if (event.key === 'ArrowLeft') next.x = clamp(next.x - step, 0, 1 - next.w)
        if (event.key === 'ArrowRight') next.x = clamp(next.x + step, 0, 1 - next.w)
        return { ...block, bbox: next }
      }))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeImageId, blocks, galleryMode])

  const activeSummary = ocrImage ? `${blocks.length} 个文本块` : '未选择图片'

  return (
    <main data-home-main className="pb-48">
      <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => void handleFiles(e.target.files, false)} />
      <input ref={batchFileInputRef} type="file" multiple accept="image/*" className="hidden" onChange={(e) => void handleFiles(e.target.files, true)} />

      <div className="safe-area-x mx-auto max-w-7xl">
        <div className="mb-4 mt-4 rounded-3xl border border-gray-200 bg-white/80 p-4 shadow-sm backdrop-blur dark:border-white/[0.08] dark:bg-gray-900/70">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="text-lg font-semibold text-gray-900 dark:text-white">OCR 模式</div>
              <div className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                支持单图与批量 OCR、拖拽改框、覆盖替换、AI 修补，以及回流到图生图 / 局部重绘 / 画廊历史。
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => fileInputRef.current?.click()} className="rounded-xl bg-blue-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-600">
                单图导入
              </button>
              <button type="button" onClick={() => batchFileInputRef.current?.click()} className="rounded-xl bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-200 dark:bg-white/[0.06] dark:text-gray-200 dark:hover:bg-white/[0.1]">
                批量导入
              </button>
              <button type="button" onClick={() => void runBatchOcr()} disabled={ocrImages.length === 0} className="rounded-xl bg-purple-50 px-4 py-2 text-sm font-medium text-purple-600 transition hover:bg-purple-100 disabled:opacity-40 dark:bg-purple-500/10 dark:text-purple-300 dark:hover:bg-purple-500/20">
                批量识别
              </button>
              <button type="button" onClick={() => void handleBatchTranslate()} disabled={ocrImages.length === 0 || batchTranslateLoading} className="rounded-xl bg-blue-50 px-4 py-2 text-sm font-medium text-blue-600 transition hover:bg-blue-100 disabled:opacity-40 dark:bg-blue-500/10 dark:text-blue-300 dark:hover:bg-blue-500/20">
                {batchTranslateLoading ? '批量翻译中' : '批量翻译'}
              </button>
              <button type="button" onClick={() => void handleBatchRender()} disabled={ocrImages.length === 0 || batchRenderLoading} className="rounded-xl bg-emerald-50 px-4 py-2 text-sm font-medium text-emerald-600 transition hover:bg-emerald-100 disabled:opacity-40 dark:bg-emerald-500/10 dark:text-emerald-300 dark:hover:bg-emerald-500/20">
                {batchRenderLoading ? '批量覆盖中' : '批量覆盖'}
              </button>
              <button type="button" onClick={() => void handleBatchAiRepair()} disabled={ocrImages.length === 0 || batchRepairLoading} className="rounded-xl bg-fuchsia-50 px-4 py-2 text-sm font-medium text-fuchsia-600 transition hover:bg-fuchsia-100 disabled:opacity-40 dark:bg-fuchsia-500/10 dark:text-fuchsia-300 dark:hover:bg-fuchsia-500/20">
                {batchRepairLoading ? '批量修补中' : '批量 AI 修补'}
              </button>
              <button type="button" onClick={() => void handleDownloadBatchResults()} disabled={ocrImages.length === 0} className="rounded-xl bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-200 disabled:opacity-40 dark:bg-white/[0.06] dark:text-gray-200 dark:hover:bg-white/[0.1]">
                批量下载结果
              </button>
              <button type="button" onClick={() => void handleSaveBatchResultsToGallery()} disabled={ocrImages.length === 0} className="rounded-xl bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-200 disabled:opacity-40 dark:bg-white/[0.06] dark:text-gray-200 dark:hover:bg-white/[0.1]">
                保存批量结果
              </button>
              <button type="button" onClick={() => setGalleryMode('generate')} className="rounded-xl bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-200 dark:bg-white/[0.06] dark:text-gray-200 dark:hover:bg-white/[0.1]">
                返回生成模式
              </button>
            </div>
          </div>
          {batchProgress && (
            <div className="mt-3 text-sm text-gray-500 dark:text-gray-400">
              批量进度：{batchProgress.done + batchProgress.failed}/{batchProgress.total}，成功 {batchProgress.done}，失败 {batchProgress.failed}
            </div>
          )}
        </div>

        <div className="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)_360px]">
          <aside className="rounded-3xl border border-gray-200 bg-white/80 p-3 shadow-sm backdrop-blur dark:border-white/[0.08] dark:bg-gray-900/70">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-sm font-semibold text-gray-800 dark:text-gray-100">任务队列</div>
              <span className="text-xs text-gray-400 dark:text-gray-500">{ocrImages.length} 张</span>
            </div>
            <div className="space-y-2">
              {ocrImages.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-gray-200 px-3 py-6 text-center text-sm text-gray-400 dark:border-white/[0.08] dark:text-gray-500">
                  先导入图片
                </div>
              ) : ocrImages.map((image, index) => (
                <button
                  key={image.id}
                  type="button"
                  onClick={() => setOcrImage(image)}
                  className={`w-full rounded-2xl border p-2 text-left transition ${
                    image.id === activeImageId
                      ? 'border-blue-500 bg-blue-50 dark:border-blue-400 dark:bg-blue-500/10'
                      : 'border-gray-200 bg-white hover:border-gray-300 dark:border-white/[0.08] dark:bg-white/[0.02] dark:hover:border-white/[0.14]'
                  }`}
                >
                  <div className="relative overflow-hidden rounded-xl bg-gray-100 dark:bg-black/20">
                    <img src={image.dataUrl} alt="" className="aspect-square w-full object-cover" />
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        removeOcrImage(image.id)
                      }}
                      className="absolute right-1 top-1 rounded-full bg-black/55 p-1 text-white transition hover:bg-black/70"
                    >
                      <CloseIcon className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-gray-800 dark:text-gray-100">图片 {index + 1}</div>
                      <div className="text-xs text-gray-400 dark:text-gray-500">{getBlocks(image.id).length} 个框</div>
                    </div>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        void runOcrForImage(image)
                      }}
                      disabled={Boolean(ocrLoadingIds[image.id])}
                      className="rounded-lg bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-700 transition hover:bg-gray-200 disabled:opacity-50 dark:bg-white/[0.06] dark:text-gray-200 dark:hover:bg-white/[0.1]"
                    >
                      {ocrLoadingIds[image.id] ? '识别中' : '识别'}
                    </button>
                  </div>
                </button>
              ))}
            </div>
          </aside>

          <section className="rounded-3xl border border-gray-200 bg-white/80 p-3 shadow-sm backdrop-blur dark:border-white/[0.08] dark:bg-gray-900/70">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-sm font-semibold text-gray-800 dark:text-gray-100">图片画布</div>
                <div className="text-xs text-gray-400 dark:text-gray-500">{activeSummary}</div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={addBlock} disabled={!ocrImage} className="rounded-xl bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-700 transition hover:bg-gray-200 disabled:opacity-40 dark:bg-white/[0.06] dark:text-gray-200 dark:hover:bg-white/[0.1]">
                  <PlusIcon className="mr-1 inline h-3.5 w-3.5" />
                  加框
                </button>
                <button type="button" onClick={deleteSelectedBlocks} disabled={!blocks.some((block) => block.selected)} className="rounded-xl bg-red-50 px-3 py-1.5 text-xs font-medium text-red-600 transition hover:bg-red-100 disabled:opacity-40 dark:bg-red-500/10 dark:text-red-300 dark:hover:bg-red-500/20">
                  删除选中
                </button>
                <button type="button" onClick={clearBlocks} disabled={blocks.length === 0} className="rounded-xl bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-700 transition hover:bg-gray-200 disabled:opacity-40 dark:bg-white/[0.06] dark:text-gray-200 dark:hover:bg-white/[0.1]">
                  清空框
                </button>
              </div>
            </div>

            <div
              ref={imagePaneRef}
              className="relative overflow-hidden rounded-2xl border border-gray-200 bg-gray-50 dark:border-white/[0.08] dark:bg-black/20"
              onPointerDown={(event) => onCanvasPointerDown(event)}
              onPointerMove={onCanvasPointerMove}
              onPointerUp={onCanvasPointerUp}
              onPointerCancel={onCanvasPointerUp}
            >
              {currentPreview ? (
                <>
                  <img src={currentPreview} alt="" className="max-h-[72vh] w-full object-contain" />
                  {blocks.map((block) => (
                    <div
                      key={block.id}
                      className={`absolute border-2 ${block.selected ? 'border-blue-500 bg-blue-500/10' : 'border-emerald-500/90 bg-emerald-500/10'}`}
                      style={{
                        left: `${block.bbox.x * 100}%`,
                        top: `${block.bbox.y * 100}%`,
                        width: `${block.bbox.w * 100}%`,
                        height: `${block.bbox.h * 100}%`,
                      }}
                      onPointerDown={(event) => {
                        event.stopPropagation()
                        onCanvasPointerDown(event, block.id)
                      }}
                    >
                      <div className="absolute -top-6 left-0 rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] text-white">
                        {block.replacementText.trim() || block.text || '文本块'}
                      </div>
                      {['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((handle) => {
                        const positionClass = handle === 'nw'
                          ? '-left-1.5 -top-1.5'
                          : handle === 'n'
                          ? 'left-1/2 -top-1.5 -translate-x-1/2'
                          : handle === 'ne'
                          ? '-right-1.5 -top-1.5'
                          : handle === 'e'
                          ? '-right-1.5 top-1/2 -translate-y-1/2'
                          : handle === 'se'
                          ? '-right-1.5 -bottom-1.5'
                          : handle === 's'
                          ? 'left-1/2 -bottom-1.5 -translate-x-1/2'
                          : handle === 'sw'
                          ? '-left-1.5 -bottom-1.5'
                          : '-left-1.5 top-1/2 -translate-y-1/2'
                        return (
                          <button
                            key={handle}
                            type="button"
                            className={`absolute h-3 w-3 rounded-full border border-white bg-blue-500 ${positionClass}`}
                            onPointerDown={(event) => {
                              event.stopPropagation()
                              onCanvasPointerDown(event, block.id, handle)
                            }}
                          />
                        )
                      })}
                    </div>
                  ))}
                </>
              ) : (
                <div className="flex min-h-[420px] items-center justify-center text-sm text-gray-400 dark:text-gray-500">
                  请选择或导入一张图片
                </div>
              )}
            </div>
          </section>

          <aside className="rounded-3xl border border-gray-200 bg-white/80 p-3 shadow-sm backdrop-blur dark:border-white/[0.08] dark:bg-gray-900/70">
            <div className="mb-3">
              <div className="text-sm font-semibold text-gray-800 dark:text-gray-100">文字与操作</div>
              <div className="text-xs text-gray-400 dark:text-gray-500">支持逐块改字、批量翻译、AI 修补和结果保存</div>
            </div>

            <div className="mb-3 grid grid-cols-2 gap-2">
              <button type="button" onClick={() => ocrImage && void runOcrForImage(ocrImage)} disabled={!ocrImage || Boolean(ocrLoadingIds[activeImageId ?? ''])} className="rounded-xl bg-gray-100 px-3 py-2 text-xs font-medium text-gray-700 transition hover:bg-gray-200 disabled:opacity-40 dark:bg-white/[0.06] dark:text-gray-200 dark:hover:bg-white/[0.1]">
                <RefreshIcon className="mr-1 inline h-3.5 w-3.5" />
                {ocrLoadingIds[activeImageId ?? ''] ? '识别中' : '重新识别'}
              </button>
              <button type="button" onClick={() => void handleTranslateAll()} disabled={!ocrImage || blocks.length === 0 || Boolean(translateLoadingIds[activeImageId ?? ''])} className="rounded-xl bg-blue-50 px-3 py-2 text-xs font-medium text-blue-600 transition hover:bg-blue-100 disabled:opacity-40 dark:bg-blue-500/10 dark:text-blue-300 dark:hover:bg-blue-500/20">
                <CodeIcon className="mr-1 inline h-3.5 w-3.5" />
                {translateLoadingIds[activeImageId ?? ''] ? '翻译中' : '翻译全部'}
              </button>
              <button type="button" onClick={() => void handleRenderOverlay()} disabled={!ocrImage || blocks.length === 0 || Boolean(renderLoadingIds[activeImageId ?? ''])} className="rounded-xl bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-600 transition hover:bg-emerald-100 disabled:opacity-40 dark:bg-emerald-500/10 dark:text-emerald-300 dark:hover:bg-emerald-500/20">
                <EditIcon className="mr-1 inline h-3.5 w-3.5" />
                {renderLoadingIds[activeImageId ?? ''] ? '生成中' : '覆盖替换'}
              </button>
              <button type="button" onClick={() => void handleAiRepair()} disabled={!ocrImage || blocks.length === 0 || Boolean(repairLoadingIds[activeImageId ?? ''])} className="rounded-xl bg-purple-50 px-3 py-2 text-xs font-medium text-purple-600 transition hover:bg-purple-100 disabled:opacity-40 dark:bg-purple-500/10 dark:text-purple-300 dark:hover:bg-purple-500/20">
                <CodeIcon className="mr-1 inline h-3.5 w-3.5" />
                {repairLoadingIds[activeImageId ?? ''] ? '修补中' : 'AI 修补'}
              </button>
            </div>

            <div className="mb-3 rounded-2xl border border-gray-200 bg-gray-50 p-3 dark:border-white/[0.08] dark:bg-black/20">
              <div className="mb-2 text-xs font-medium text-gray-500 dark:text-gray-400">AI 修补强度</div>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { value: 'light', label: '轻修补' },
                  { value: 'clean', label: '标准修补' },
                  { value: 'creative', label: '增强修补' },
                  { value: 'none', label: '仅改字' },
                ].map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => activeImageId && setRepairPresetByImageId((prev) => ({ ...prev, [activeImageId]: option.value as RepairPreset }))}
                    className={`rounded-xl px-3 py-2 text-xs font-medium transition ${currentRepairPreset === option.value ? 'bg-blue-500 text-white' : 'bg-white text-gray-700 hover:bg-gray-100 dark:bg-white/[0.04] dark:text-gray-200 dark:hover:bg-white/[0.08]'}`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="mb-3 grid grid-cols-2 gap-2">
              <button type="button" onClick={activateImageToImage} disabled={!ocrImage} className="rounded-xl bg-gray-100 px-3 py-2 text-xs font-medium text-gray-700 transition hover:bg-gray-200 disabled:opacity-40 dark:bg-white/[0.06] dark:text-gray-200 dark:hover:bg-white/[0.1]">
                送回图生图
              </button>
              <button type="button" onClick={() => void activateMaskEdit()} disabled={!ocrImage || blocks.length === 0} className="rounded-xl bg-gray-100 px-3 py-2 text-xs font-medium text-gray-700 transition hover:bg-gray-200 disabled:opacity-40 dark:bg-white/[0.06] dark:text-gray-200 dark:hover:bg-white/[0.1]">
                送去局部重绘
              </button>
            </div>
            <div className="mb-3">
              <button type="button" onClick={() => void activateBatchImageToImage()} disabled={ocrImages.length === 0} className="w-full rounded-xl bg-gray-100 px-3 py-2 text-xs font-medium text-gray-700 transition hover:bg-gray-200 disabled:opacity-40 dark:bg-white/[0.06] dark:text-gray-200 dark:hover:bg-white/[0.1]">
                批量送回图生图
              </button>
            </div>

            <div className="space-y-3">
              {blocks.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-gray-200 px-3 py-8 text-center text-sm text-gray-400 dark:border-white/[0.08] dark:text-gray-500">
                  先识别，或直接在左侧拖拽画框
                </div>
              ) : blocks.map((block, index) => (
                <div key={block.id} className={`rounded-2xl border p-3 transition ${block.selected ? 'border-blue-500 bg-blue-50 dark:border-blue-400 dark:bg-blue-500/10' : 'border-gray-200 bg-white dark:border-white/[0.08] dark:bg-white/[0.02]'}`}>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <button type="button" onClick={() => selectSingleBlock(block.id)} className="text-left text-xs font-medium text-gray-500 dark:text-gray-400">
                      文本块 {index + 1}
                    </button>
                    <div className="text-[11px] text-gray-400 dark:text-gray-500">
                      x {block.bbox.x.toFixed(2)} · y {block.bbox.y.toFixed(2)}
                    </div>
                  </div>
                  <textarea
                    value={block.text}
                    onChange={(event) => updateBlock(block.id, { text: event.target.value })}
                    className="mb-2 min-h-[64px] w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700 outline-none transition focus:border-blue-400 dark:border-white/[0.08] dark:bg-black/20 dark:text-gray-200"
                    placeholder="原文"
                  />
                  <textarea
                    value={block.replacementText}
                    onChange={(event) => updateBlock(block.id, { replacementText: event.target.value })}
                    className="min-h-[72px] w-full rounded-xl border border-blue-200 bg-white px-3 py-2 text-sm text-gray-700 outline-none transition focus:border-blue-400 dark:border-blue-500/30 dark:bg-white/[0.03] dark:text-gray-200"
                    placeholder="替换文字"
                  />
                </div>
              ))}
            </div>

            {activeImageId && previewByImageId[activeImageId] && (
              <div className="mt-3 grid gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    const preview = previewByImageId[activeImageId]
                    if (!preview) return
                    const imageId = await storeImage(preview, 'generated')
                    setLightboxImageId(imageId, [imageId])
                  }}
                  className="w-full rounded-xl bg-gray-100 px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-200 dark:bg-white/[0.06] dark:text-gray-200 dark:hover:bg-white/[0.1]"
                >
                  <DownloadIcon className="mr-1 inline h-4 w-4" />
                  打开当前结果
                </button>
                <button
                  type="button"
                  onClick={() => void handleSaveCurrentResultToGallery()}
                  disabled={!renderedByImageId[activeImageId]}
                  className="w-full rounded-xl bg-gray-100 px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-200 disabled:opacity-40 dark:bg-white/[0.06] dark:text-gray-200 dark:hover:bg-white/[0.1]"
                >
                  保存当前结果
                </button>
              </div>
            )}
          </aside>
        </div>
      </div>
    </main>
  )
}
