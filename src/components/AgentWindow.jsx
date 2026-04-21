export default function AgentWindow({
  children,
  contained = false,
  description = '关闭窗口时会触发当前面板注册的清理逻辑。',
  onClose,
  bodyClassName = '',
  closeButtonClassName = '',
  descriptionClassName = '',
  headerClassName = '',
  overlayClassName = '',
  panelClassName = '',
  sizeClassName = '',
  title,
  titleClassName = '',
}) {
  const handleClose = () => {
    onClose?.()
  }

  const overlayBaseClassName = contained
    ? 'absolute inset-0 z-30 flex items-center justify-center bg-[rgba(15,23,42,0.22)] p-5 backdrop-blur-[2px]'
    : 'fixed inset-0 z-50 flex items-center justify-center bg-[rgba(15,23,42,0.2)] p-4 backdrop-blur-[2px]'

  const defaultSizeClassName = contained ? 'h-[86%] w-[88%] max-w-[1240px]' : 'h-[80vh] w-[80vw] max-w-[1440px]'

  return (
    <div className={`${overlayBaseClassName} ${overlayClassName}`}>
      <button aria-label="关闭遮罩" className="absolute inset-0" onClick={handleClose} type="button" />
      <section
        className={`relative z-10 flex min-h-[360px] min-w-[320px] flex-col overflow-hidden rounded-[32px] border border-[#eceef3] bg-white shadow-[0_24px_80px_rgba(15,23,42,0.18)] ${defaultSizeClassName} ${sizeClassName} ${panelClassName}`}
      >
        <div className={`flex shrink-0 items-center justify-between border-b border-[#eceef3] px-6 py-5 ${headerClassName}`}>
          <div>
            <h3 className={`text-[22px] font-semibold tracking-[-0.03em] text-[#111827] ${titleClassName}`}>{title}</h3>
            <p className={`mt-1 text-sm text-[#6b7280] ${descriptionClassName}`}>{description}</p>
          </div>
          <button
            className={`inline-flex h-10 w-10 items-center justify-center rounded-full bg-[#f5f7fb] text-[#6b7280] transition hover:bg-[#eef2f7] ${closeButtonClassName}`}
            onClick={handleClose}
            type="button"
          >
            ×
          </button>
        </div>
        <div className={`min-h-0 flex-1 p-6 ${bodyClassName}`}>{children}</div>
      </section>
    </div>
  )
}
