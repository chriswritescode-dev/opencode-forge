import type { ForgeTuiHost } from './host'
import type { ForgeSandboxTemplateBuildOutput, ForgeSandboxTemplateBuildStatus } from '../host/forge-rpc'
import type { SelectRenderable } from '@opentui/core'
import type { SandboxBuildStage } from '../sandbox/template'
import { createMemo, createSignal, For, onCleanup, Show, untrack } from 'solid-js'
import { claimFocusOnMount } from './focus'

const BUILD_PROGRESS_BAR_WIDTH = 24
const BUILD_POLL_INTERVAL_MS = 500
const CONFIRM_DETAIL = 'A first build downloads and installs everything; expect several minutes.'

const BUILD_STAGE_LABELS = {
  build: 'Building image',
  save: 'Saving image',
  load: 'Loading into msb',
} satisfies Record<SandboxBuildStage, string>

export type SandboxBuildDialogPhase = 'confirm' | 'running' | 'success' | 'error'

export interface SandboxBuildDialogStatusView {
  phase: SandboxBuildDialogPhase
  status: ForgeSandboxTemplateBuildStatus | null
  error?: string
}

function renderProgressBar(ratio: number): string {
  const filled = Math.max(0, Math.min(BUILD_PROGRESS_BAR_WIDTH, Math.round(ratio * BUILD_PROGRESS_BAR_WIDTH)))
  return `[${'█'.repeat(filled)}${'░'.repeat(BUILD_PROGRESS_BAR_WIDTH - filled)}]`
}

function formatElapsed(elapsedMs: number | undefined): string {
  const totalSeconds = Math.max(0, Math.floor((elapsedMs ?? 0) / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

export interface SandboxBuildStatusText {
  statusLine: string
  detailLine: string
}

export function describeSandboxBuildStatus(view: SandboxBuildDialogStatusView): SandboxBuildStatusText {
  const status = view.status
  const elapsed = formatElapsed(status?.elapsedMs)
  if (view.phase === 'confirm') {
    return { statusLine: 'Ready to build.', detailLine: view.error || CONFIRM_DETAIL }
  }
  if (view.phase === 'success') {
    return { statusLine: `Built and loaded in ${elapsed}.`, detailLine: '' }
  }
  if (view.phase === 'error') {
    return { statusLine: `Failed after ${elapsed}: ${view.error ?? status?.failure ?? 'unknown error'}`, detailLine: '' }
  }
  const label = status?.stage ? BUILD_STAGE_LABELS[status.stage] : BUILD_STAGE_LABELS.build
  const step = status?.step
  const ratio = step && step.total > 0 ? step.current / step.total : null
  const statusLine = ratio === null
    ? `${label}... ${elapsed}`
    : `${renderProgressBar(ratio)} ${Math.round(ratio * 100)}%  ${label} ${step?.current}/${step?.total}  ${elapsed}`
  const detailLine = view.error || (step?.description ?? status?.lastLine ?? '').slice(0, 96)
  return { statusLine, detailLine }
}

export function SandboxBuildDialog(props: {
  host: ForgeTuiHost
  start: () => Promise<ForgeSandboxTemplateBuildOutput>
  readStatus: () => Promise<ForgeSandboxTemplateBuildOutput>
}) {
  const colors = () => props.host.colors()
  const readStatus = untrack(() => props.readStatus)
  const start = untrack(() => props.start)

  const [status, setStatus] = createSignal<ForgeSandboxTemplateBuildStatus | null>(null)
  const [statusError, setStatusError] = createSignal('')
  const [startError, setStartError] = createSignal('')
  const [engaged, setEngaged] = createSignal(false)

  let disposed = false
  let pollTimer: ReturnType<typeof setTimeout> | undefined
  let starting = false
  let selectRef: SelectRenderable | undefined
  claimFocusOnMount(() => selectRef)

  const stopPolling = () => {
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = undefined
  }
  onCleanup(() => {
    disposed = true
    stopPolling()
  })

  const phase = createMemo<SandboxBuildDialogPhase>(() => {
    if (startError()) return 'error'
    const current = engaged() ? status() : null
    if (!current || current.phase === 'idle') return 'confirm'
    return current.phase
  })

  const schedulePoll = () => {
    if (disposed) return
    stopPolling()
    pollTimer = setTimeout(() => {
      pollTimer = undefined
      void pollOnce()
    }, BUILD_POLL_INTERVAL_MS)
  }

  const pollOnce = async () => {
    const output = await readStatus()
    if (disposed) return
    if ('error' in output) {
      setStatusError(output.error)
    } else {
      setStatusError('')
      setStatus(output)
    }
    if (phase() === 'running') schedulePoll()
    else stopPolling()
  }

  void (async () => {
    const output = await readStatus()
    if (disposed || untrack(engaged)) return
    if ('error' in output) {
      setStatusError(output.error)
      return
    }
    setStatus(output)
    if (output.phase === 'running') {
      setEngaged(true)
      schedulePoll()
    }
  })()

  const image = () => status()?.image ?? '...'
  const contextDir = () => status()?.contextDir ?? '...'

  const text = createMemo(() => describeSandboxBuildStatus({
    phase: phase(),
    status: status(),
    error: phase() === 'error' ? startError() || undefined : statusError() || undefined,
  }))

  const tail = () => (startError() ? [] : (status()?.tail ?? []))

  const statusColor = createMemo(() => (phase() === 'error' ? colors().error : colors().text))

  const selectOptions = createMemo(() => {
    if (phase() === 'confirm') {
      return [
        { name: 'Build', description: 'Press enter to build the sandbox image', value: 'build' },
        { name: 'Cancel', description: 'Press enter to close this dialog', value: 'cancel' },
      ]
    }
    if (phase() === 'running') {
      return [{ name: 'Close', description: 'The build keeps running and reports with a toast', value: 'cancel' }]
    }
    return [{ name: 'Close', description: 'Press enter to close this dialog', value: 'cancel' }]
  })

  const doBuild = async () => {
    if (starting) return
    starting = true
    setStatusError('')
    setStartError('')
    props.host.toast({ message: `Building ${image()}...`, variant: 'info', duration: 4000 })
    try {
      const output = await start()
      if (disposed) return
      if ('error' in output) {
        const current = await readStatus()
        if (disposed) return
        if (!('error' in current) && current.phase === 'running') {
          setStatus(current)
          setEngaged(true)
          schedulePoll()
          return
        }
        setStartError(output.error)
        props.host.toast({ message: output.error, variant: 'error', duration: 10_000 })
        return
      }
      setStatus(output)
      setEngaged(true)
      schedulePoll()
    } finally {
      starting = false
    }
  }

  return (
    <box flexDirection="column" paddingX={2}>
      <box flexShrink={0} paddingBottom={1} flexDirection="row" gap={1}>
        <text fg={colors().text}>
          <b>Build sandbox template</b>
        </text>
      </box>

      <box paddingBottom={1}>
        <text fg={colors().textMuted}>
          This builds the sandbox image with Docker on the machine running the OpenCode server, then loads it into msb.
        </text>
      </box>
      <box paddingBottom={1}>
        <text fg={colors().textMuted}>Image: {image()}</text>
      </box>
      <box paddingBottom={1}>
        <text fg={colors().textMuted}>Context (server): {contextDir()}</text>
      </box>

      <box paddingBottom={1} flexDirection="column">
        <text fg={statusColor()}>{text().statusLine}</text>
        <text fg={colors().textMuted}>{text().detailLine}</text>
      </box>

      <Show when={phase() === 'error'}>
        <box paddingBottom={1} flexDirection="column">
          <For each={tail()}>{(line) => <text fg={colors().textMuted}>{line.slice(0, 96)}</text>}</For>
        </box>
      </Show>

      <box paddingTop={1} paddingX={1} flexShrink={0}>
        <select
          ref={(el) => { selectRef = el }}
          focused={true}
          selectedIndex={0}
          options={selectOptions()}
          onSelect={(_, option) => {
            if (option?.value === 'build') {
              void doBuild()
              return
            }
            if (option?.value === 'cancel') {
              props.host.clearDialog()
            }
          }}
          showDescription={true}
          itemSpacing={1}
          wrapSelection={true}
          textColor={colors().text}
          focusedTextColor={colors().text}
          selectedTextColor={colors().selectedText}
          selectedBackgroundColor={colors().selectedBackground}
          minHeight={4}
          flexShrink={0}
        />
      </box>
    </box>
  )
}

export function openSandboxBuildDialog(
  host: ForgeTuiHost,
  deps: {
    start: () => Promise<ForgeSandboxTemplateBuildOutput>
    readStatus: () => Promise<ForgeSandboxTemplateBuildOutput>
  },
): void {
  host.showDialog('medium', () => (
    <SandboxBuildDialog host={host} start={deps.start} readStatus={deps.readStatus} />
  ))
}
