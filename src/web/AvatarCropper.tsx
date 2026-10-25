import { useRef, useState, type PointerEvent, type SyntheticEvent } from 'react'

interface Props {
  src: string
  onCancel: () => void
  onConfirm: (dataUrl: string) => void
}

const STAGE = 320
const OUTPUT = 320
const MIN_BOX = 48

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

interface Layout {
  dispW: number
  dispH: number
  offsetX: number
  offsetY: number
}

export default function AvatarCropper({ src, onCancel, onConfirm }: Props) {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)

  const [layout, setLayout] = useState<Layout | null>(null)
  const [box, setBox] = useState({ x: 0, y: 0, size: 0 })
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null)

  function handleLoad(event: SyntheticEvent<HTMLImageElement>) {
    const img = event.currentTarget
    if (!img.naturalWidth || !img.naturalHeight) return

    const scale = Math.min(STAGE / img.naturalWidth, STAGE / img.naturalHeight)
    const dispW = img.naturalWidth * scale
    const dispH = img.naturalHeight * scale
    const offsetX = (STAGE - dispW) / 2
    const offsetY = (STAGE - dispH) / 2

    const size = Math.min(dispW, dispH) * 0.8
    setLayout({ dispW, dispH, offsetX, offsetY })
    setBox({
      x: offsetX + (dispW - size) / 2,
      y: offsetY + (dispH - size) / 2,
      size,
    })
  }

  function pointerPosition(event: PointerEvent) {
    const rect = stageRef.current?.getBoundingClientRect()
    if (!rect) return { px: 0, py: 0 }
    return { px: event.clientX - rect.left, py: event.clientY - rect.top }
  }

  function handleDown(event: PointerEvent) {
    if (!layout) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const { px, py } = pointerPosition(event)
    setDrag({ dx: px - box.x, dy: py - box.y })
  }

  function handleMove(event: PointerEvent) {
    if (!drag || !layout) return
    const { px, py } = pointerPosition(event)
    setBox({
      ...box,
      x: clamp(px - drag.dx, layout.offsetX, layout.offsetX + layout.dispW - box.size),
      y: clamp(py - drag.dy, layout.offsetY, layout.offsetY + layout.dispH - box.size),
    })
  }

  function handleUp() {
    setDrag(null)
  }

  function resize(size: number) {
    if (!layout) return
    const maxSize = Math.min(layout.dispW, layout.dispH)
    const next = clamp(size, MIN_BOX, maxSize)
    const centerX = box.x + box.size / 2
    const centerY = box.y + box.size / 2
    setBox({
      size: next,
      x: clamp(centerX - next / 2, layout.offsetX, layout.offsetX + layout.dispW - next),
      y: clamp(centerY - next / 2, layout.offsetY, layout.offsetY + layout.dispH - next),
    })
  }

  function confirm() {
    const img = imgRef.current
    if (!img || !layout) return

    const factor = img.naturalWidth / layout.dispW
    const sx = (box.x - layout.offsetX) * factor
    const sy = (box.y - layout.offsetY) * factor
    const sSize = box.size * factor

    const canvas = document.createElement('canvas')
    canvas.width = OUTPUT
    canvas.height = OUTPUT
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.drawImage(img, sx, sy, sSize, sSize, 0, 0, OUTPUT, OUTPUT)
    onConfirm(canvas.toDataURL('image/png'))
  }

  const maxSize = layout ? Math.min(layout.dispW, layout.dispH) : STAGE

  return (
    <div className="backdrop cropper-backdrop">
      <div className="modal">
        <div className="modal-head">
          <h2>调整头像</h2>
          <button className="link" onClick={onCancel}>
            取消
          </button>
        </div>

        <p className="hint">拖动方框选择保留的区域，用滑块调整大小。</p>

        <div className="cropper-stage" ref={stageRef}>
          <img
            ref={imgRef}
            src={src}
            alt=""
            draggable={false}
            onLoad={handleLoad}
            style={{
              width: layout ? layout.dispW : 1,
              height: layout ? layout.dispH : 1,
              left: layout ? layout.offsetX : 0,
              top: layout ? layout.offsetY : 0,
              opacity: layout ? 1 : 0,
            }}
          />

          {layout && (
            <div
              className="cropper-box"
              style={{ left: box.x, top: box.y, width: box.size, height: box.size }}
              onPointerDown={handleDown}
              onPointerMove={handleMove}
              onPointerUp={handleUp}
              onPointerCancel={handleUp}
            />
          )}
        </div>

        {layout && (
          <label className="cropper-size">
            选区大小
            <input
              type="range"
              min={MIN_BOX}
              max={Math.round(maxSize)}
              value={Math.round(box.size)}
              onChange={(e) => resize(Number(e.target.value))}
            />
          </label>
        )}

        <div className="actions">
          <button className="primary" onClick={confirm} disabled={!layout}>
            使用这块
          </button>
          <button className="ghost" onClick={onCancel}>
            取消
          </button>
        </div>
      </div>
    </div>
  )
}
