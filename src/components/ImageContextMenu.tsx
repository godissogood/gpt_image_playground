import React, { useEffect, useRef, useState } from 'react'
import { addImageFromUrl, ensureImageCached, openImageInOcrMode, useStore } from '../store'
import { copyImageSourceToClipboard, getClipboardFailureMessage } from '../lib/clipboard'
import { downloadImageEntriesAsZip, downloadImageIds, formatExportFileTime, getImageZipEntries } from '../lib/downloadImages'
import { suppressGlobalClicks } from '../lib/clickSuppression'
import { CodeIcon, CopyIcon, DownloadIcon, EditIcon } from './icons'

type MenuInfo = {
  src: string
  imageId?: string
  outputImageIds: string[]
  x: number
  y: number
}

export default function ImageContextMenu() {
  const [menuInfo, setMenuInfo] = useState<MenuInfo | null>(null)
  const showToast = useStore((s) => s.showToast)
  const inputImages = useStore((s) => s.inputImages)
  const setDetailTaskId = useStore((s) => s.setDetailTaskId)
  const setLightboxImageId = useStore((s) => s.setLightboxImageId)
  const setMaskEditorImageId = useStore((s) => s.setMaskEditorImageId)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (isEmbeddedPage()) return

    const onContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (!target || target.tagName !== 'IMG') return

      const imgTarget = target as HTMLImageElement
      if (!imgTarget.src) return

      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
      const isTouch = window.matchMedia('(pointer: coarse)').matches
      if (isIOS && isTouch) return

      e.preventDefault()
      setMenuInfo({
        src: imgTarget.src,
        imageId: imgTarget.dataset.imageId,
        outputImageIds: imgTarget.dataset.outputImageIds?.split(',').filter(Boolean) ?? [],
        x: e.clientX,
        y: e.clientY,
      })
    }

    window.addEventListener('contextmenu', onContextMenu)
    return () => window.removeEventListener('contextmenu', onContextMenu)
  }, [])

  useEffect(() => {
    if (!menuInfo) return

    const close = (e: Event) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return
      if (e.target instanceof Element && e.target.closest('[data-lightbox-root]')) {
        window.dispatchEvent(new Event('image-context-menu-dismiss-lightbox-click'))
      }
      if (e.type === 'mousedown' || e.type === 'touchstart') suppressGlobalClicks()
      setMenuInfo(null)
    }

    window.addEventListener('mousedown', close, { capture: true })
    window.addEventListener('touchstart', close, { capture: true })
    window.addEventListener('wheel', close, { capture: true })
    window.addEventListener('scroll', close, { capture: true })
    window.addEventListener('resize', close)

    return () => {
      window.removeEventListener('mousedown', close, { capture: true })
      window.removeEventListener('touchstart', close, { capture: true })
      window.removeEventListener('wheel', close, { capture: true })
      window.removeEventListener('scroll', close, { capture: true })
      window.removeEventListener('resize', close)
    }
  }, [menuInfo])

  if (!menuInfo) return null

  const getOriginalImageSrc = async () => {
    if (!menuInfo.imageId) return menuInfo.src
    return await ensureImageCached(menuInfo.imageId) ?? menuInfo.src
  }

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation()
    setMenuInfo(null)
    try {
      await copyImageSourceToClipboard(getOriginalImageSrc())
      showToast('图片已复制', 'success')
    } catch (err) {
      console.error(err)
      showToast(getClipboardFailureMessage('复制失败', err), 'error')
    }
  }

  const handleDownload = async (e: React.MouseEvent) => {
    e.stopPropagation()
    const imageId = menuInfo.imageId
    const src = menuInfo.src
    setMenuInfo(null)

    try {
      let fileNameBase = ''
      if (imageId) {
        const tasks = useStore.getState().tasks
        const matchedTask = tasks.find((task) => task.outputImages?.includes(imageId))
        fileNameBase = matchedTask ? `task-${matchedTask.id}` : `image-${imageId}`
      } else {
        fileNameBase = `image-${formatExportFileTime(new Date())}`
      }

      const result = await downloadImageIds([imageId || src], fileNameBase)
      showToast(result.successCount === 0 ? '下载失败' : '下载成功', result.successCount === 0 ? 'error' : 'success')
    } catch (err) {
      console.error(err)
      showToast('下载失败', 'error')
    }
  }

  const handleDownloadAll = async (e: React.MouseEvent) => {
    e.stopPropagation()
    const outputImageIds = menuInfo.outputImageIds
    setMenuInfo(null)
    if (outputImageIds.length <= 1) return

    try {
      let fileNameBase = ''
      if (outputImageIds[0]) {
        const tasks = useStore.getState().tasks
        const matchedTask = tasks.find((task) => task.outputImages?.includes(outputImageIds[0]))
        if (matchedTask) fileNameBase = `task-${matchedTask.id}`
      }
      if (!fileNameBase) fileNameBase = `batch-${formatExportFileTime(new Date())}`

      const settings = useStore.getState().settings
      const result = settings.zipDownloadRoutes.includes('image-context-menu-all')
        ? await downloadImageEntriesAsZip(getImageZipEntries(outputImageIds, fileNameBase), fileNameBase)
        : await downloadImageIds(outputImageIds, fileNameBase)

      if (result.successCount === 0) showToast('下载失败', 'error')
      else if (result.failCount > 0) showToast(`部分下载失败：成功 ${result.successCount}，失败 ${result.failCount}`, 'error')
      else showToast(result.successCount > 1 ? `下载成功：${result.successCount} 张图片` : '下载成功', 'success')
    } catch (err) {
      console.error(err)
      showToast('下载失败', 'error')
    }
  }

  const handleEdit = async (e: React.MouseEvent) => {
    e.stopPropagation()
    setMenuInfo(null)
    if (inputImages.length >= 16) {
      showToast('参考图数量已达上限（16 张），无法继续添加', 'error')
      return
    }

    try {
      const src = await getOriginalImageSrc()
      await addImageFromUrl(src)
      setDetailTaskId(null)
      setLightboxImageId(null)
      setMaskEditorImageId(null)
      showToast('已加入参考图', 'success')
    } catch (err) {
      console.error(err)
      showToast(`加入参考图失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    }
  }

  const handleOpenOcr = async (e: React.MouseEvent) => {
    e.stopPropagation()
    const imageId = menuInfo.imageId
    setMenuInfo(null)

    try {
      const src = await getOriginalImageSrc()
      await openImageInOcrMode(imageId, src)
      showToast('已打开 OCR 模式', 'success')
    } catch (err) {
      console.error(err)
      showToast(`打开 OCR 模式失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    }
  }

  let left = menuInfo.x
  let top = menuInfo.y
  const menuWidth = 136
  const showDownloadAll = menuInfo.outputImageIds.length > 1
  const menuHeight = showDownloadAll ? 196 : 164

  if (left + menuWidth > window.innerWidth) left -= menuWidth
  if (top + menuHeight > window.innerHeight) top -= menuHeight

  return (
    <div
      ref={menuRef}
      className="fixed z-[9999] w-[136px] overflow-hidden rounded-lg border border-gray-100 bg-white py-1 shadow-xl animate-fade-in dark:border-gray-700 dark:bg-gray-800"
      style={{ left, top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button
        onClick={handleCopy}
        className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-gray-700 transition-colors hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-700/50"
      >
        <CopyIcon className="h-4 w-4 flex-shrink-0" />
        复制
      </button>
      <button
        onClick={handleDownload}
        className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-gray-700 transition-colors hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-700/50"
      >
        <DownloadIcon className="h-4 w-4 flex-shrink-0" />
        下载
      </button>
      {showDownloadAll && (
        <button
          onClick={handleDownloadAll}
          className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-gray-700 transition-colors hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-700/50"
        >
          <DownloadIcon className="h-4 w-4 flex-shrink-0" />
          下载全部
        </button>
      )}
      <button
        onClick={handleEdit}
        className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-gray-700 transition-colors hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-700/50"
      >
        <EditIcon className="h-4 w-4 flex-shrink-0" />
        继续编辑
      </button>
      <button
        onClick={handleOpenOcr}
        className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-gray-700 transition-colors hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-700/50"
      >
        <CodeIcon className="h-4 w-4 flex-shrink-0" />
        打开 OCR
      </button>
    </div>
  )
}

function isEmbeddedPage() {
  try {
    return window.self !== window.top
  } catch {
    return true
  }
}
