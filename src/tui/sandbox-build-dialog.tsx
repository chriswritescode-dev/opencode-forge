/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from '@opencode-ai/plugin/tui'
import type { SelectRenderable } from '@opentui/core'
import { createMemo, createSignal, For, onCleanup, Show } from 'solid-js'
import { tmpdir } from 'os'
import { claimFocusOnMount } from './focus'
import { createMsbRuntime } from '../sandbox/msb'
import { buildAndLoadSandboxTemplate, type SandboxBuildStage } from '../sandbox/template'
import { runCommand } from '../sandbox/process'

const BUILD_PROGRESS_BAR_WIDTH = 24
/** Output lines retained for the failure view; a truncated last line rarely explains a docker failure. */
const BUILD_TAIL_LIMIT = 12
/** Upper bound on dialog repaints from streamed output, which can arrive hundreds of lines per second. */
const BUILD_REPAINT_INTERVAL_MS = 100

const BUILD_STAGE_LABELS: Record<SandboxBuildStage, string> = {
  build: 'Building image',
  save: 'Saving image',
  load: 'Loading into msb',
}

function renderProgressBar(ratio: number): string {
  const filled = Math.max(0, Math.min(BUILD_PROGRESS_BAR_WIDTH, Math.round(ratio * BUILD_PROGRESS_BAR_WIDTH)))
  return `[${'█'.repeat(filled)}${'░'.repeat(BUILD_PROGRESS_BAR_WIDTH - filled)}]`
}

function formatElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

export function SandboxBuildDialog(props: {
  api: TuiPluginApi
  buildContextDir: string
  image: string
  browserControl: boolean
}) {
  const theme = () => props.api.theme.current

  type BuildPhase = 'confirm' | 'running' | 'success' | 'error'
  const [phase, setPhase] = createSignal<BuildPhase>('confirm')
  const [stage, setStage] = createSignal<SandboxBuildStage>('build')
  const [step, setStep] = createSignal<{ current: number; total: number; description: string } | null>(null)
  const [lastLine, setLastLine] = createSignal('')
  const [elapsedSeconds, setElapsedSeconds] = createSignal(0)
  const [errorMessage, setErrorMessage] = createSignal('')
  const [tail, setTail] = createSignal<string[]>([])

  const outputTail: string[] = []
  let timer: ReturnType<typeof setInterval> | undefined
  let lastRepaintAt = 0
  let selectRef: SelectRenderable | undefined
  claimFocusOnMount(() => selectRef)

  const stopTimer = () => {
    if (timer) clearInterval(timer)
    timer = undefined
  }
  onCleanup(stopTimer)

  const statusLine = createMemo(() => {
    if (phase() === 'confirm') return 'Ready to build.'
    if (phase() === 'success') return `Built and loaded in ${formatElapsed(elapsedSeconds())}.`
    if (phase() === 'error') return `Failed after ${formatElapsed(elapsedSeconds())}: ${errorMessage()}`
    const label = BUILD_STAGE_LABELS[stage()]
    const current = step()
    if (!current) return `${label}... ${formatElapsed(elapsedSeconds())}`
    const ratio = current.current / current.total
    return `${renderProgressBar(ratio)} ${Math.round(ratio * 100)}%  ${label} ${current.current}/${current.total}  ${formatElapsed(elapsedSeconds())}`
  })

  const detailLine = createMemo(() => {
    if (phase() === 'confirm') return 'A first build downloads and installs everything; expect several minutes.'
    if (phase() !== 'running') return ''
    return (step()?.description ?? lastLine()).slice(0, 96)
  })

  const statusColor = createMemo(() => (phase() === 'error' ? theme().error : theme().text))

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

  // A repeated Enter can reach `onSelect` again before the phase render lands.
  // Latching here keeps the second press from overwriting this dialog's state
  // with the concurrent-build rejection while the first build is still running.
  let started = false

  const doBuild = async () => {
    if (started) return
    started = true
    setPhase('running')
    // Fires before any Docker work, so it also proves the keypress reached this
    // handler even if the dialog itself fails to repaint.
    props.api.ui.toast({ message: `Building ${props.image}...`, variant: 'info', duration: 4000 })
    const startedAt = Date.now()
    timer = setInterval(() => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000)

    const logger = { log: () => {}, error: () => {}, debug: () => {} }

    try {
      await buildAndLoadSandboxTemplate(props.buildContextDir, props.image, {
        runCommand,
        loadTemplate: (tar, ref) => createMsbRuntime(logger).loadTemplate(tar, ref),
        logger,
        tmpDir: tmpdir(),
        onProgress: (progress) => {
          outputTail.push(progress.line)
          if (outputTail.length > BUILD_TAIL_LIMIT) outputTail.shift()
          if (progress.stage !== stage()) {
            setStage(progress.stage)
            setStep(null)
          }
          // BuildKit resolves a DAG, so it announces steps out of order (7/13 can
          // precede 5/13). Tracking the furthest step reached keeps the bar monotonic.
          if (progress.step && progress.step.current >= (step()?.current ?? 0)) setStep(progress.step)
          const now = Date.now()
          if (now - lastRepaintAt < BUILD_REPAINT_INTERVAL_MS) return
          lastRepaintAt = now
          setLastLine(progress.line)
        },
      }, { browserControl: props.browserControl })
      stopTimer()
      setPhase('success')
      props.api.ui.toast({
        message: `Sandbox template ${props.image} built and loaded successfully`,
        variant: 'success',
        duration: 5000,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      stopTimer()
      setTail([...outputTail])
      setErrorMessage(message)
      setPhase('error')
      props.api.ui.toast({ message, variant: 'error', duration: 10_000 })
    }
  }

  return (
    <box flexDirection="column" paddingX={2}>
      <box flexShrink={0} paddingBottom={1} flexDirection="row" gap={1}>
        <text fg={theme().text}>
          <b>Build sandbox template</b>
        </text>
      </box>

      <box paddingBottom={1}>
        <text fg={theme().textMuted}>
          This builds the sandbox image with Docker, then loads it into msb.
        </text>
      </box>
      <box paddingBottom={1}>
        <text fg={theme().textMuted}>Image: {props.image}</text>
      </box>
      <box paddingBottom={1}>
        <text fg={theme().textMuted}>Context: {props.buildContextDir}</text>
      </box>
      <box paddingBottom={1}>
        <text fg={theme().textMuted}>Browser Control: {props.browserControl ? 'included' : 'excluded'}</text>
      </box>

      <box paddingBottom={1} flexDirection="column">
        <text fg={statusColor()}>{statusLine()}</text>
        <text fg={theme().textMuted}>{detailLine()}</text>
      </box>

      <Show when={phase() === 'error'}>
        <box paddingBottom={1} flexDirection="column">
          <For each={tail()}>{(line) => <text fg={theme().textMuted}>{line.slice(0, 96)}</text>}</For>
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
              props.api.ui.dialog.clear()
            }
          }}
          showDescription={true}
          itemSpacing={1}
          wrapSelection={true}
          textColor={theme().text}
          focusedTextColor={theme().text}
          selectedTextColor="#ffffff"
          selectedBackgroundColor={theme().borderActive}
          minHeight={4}
          flexShrink={0}
        />
      </box>
    </box>
  )
}
