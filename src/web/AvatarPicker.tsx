import { useRef, useState } from 'react'
import AvatarCropper from './AvatarCropper.tsx'

interface Props {
  /** 当前要显示的图（data URL 或已有头像地址） */
  value?: string
  /** null = 移除头像 */
  onChange: (dataUrl: string | null) => void
}

const ACCEPT = 'image/png,image/jpeg,image/webp'
const MAX_BYTES = 8 * 1024 * 1024

export default function AvatarPicker({ value, onChange }: Props) {
  const ref = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  /** 待裁剪的原图 */
  const [source, setSource] = useState<string | null>(null)

  function pick(file: File) {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
      setError('只支持 PNG / JPEG / WebP 格式的图片。')
      return
    }
    if (file.size > MAX_BYTES) {
      setError('图片超过 8MB，换一张小一点的。')
      return
    }

    setError(null)
    const reader = new FileReader()
    reader.onload = () => setSource(String(reader.result))
    reader.onerror = () => setError('读取图片失败。')
    reader.readAsDataURL(file)
  }

  return (
    <div className="avatar-picker">
      <div className="avatar-frame">
        {value ? <img src={value} alt="头像预览" /> : <span className="avatar-empty">无头像</span>}
      </div>

      <input
        ref={ref}
        type="file"
        accept={ACCEPT}
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) pick(file)
          e.target.value = ''
        }}
      />

      <div className="avatar-actions">
        <button type="button" className="link" onClick={() => ref.current?.click()}>
          {value ? '更换头像' : '选择头像'}
        </button>
        {value && (
          <button type="button" className="link" onClick={() => onChange(null)}>
            移除
          </button>
        )}
      </div>

      {error && <p className="notice error small">{error}</p>}

      {source && (
        <AvatarCropper
          src={source}
          onCancel={() => setSource(null)}
          onConfirm={(dataUrl) => {
            onChange(dataUrl)
            setSource(null)
          }}
        />
      )}
    </div>
  )
}
