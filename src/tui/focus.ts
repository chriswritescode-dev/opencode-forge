import { onMount } from 'solid-js'

/**
 * Re-assert keyboard focus for a modal element after it mounts.
 *
 * `focused={true}` is not a standing declaration: @opentui/solid maps it to a
 * single `renderable.focus()` call while applying props during the initial
 * render pass. Anything the host focuses afterwards — opencode's prompt input,
 * another TUI plugin — silently wins, and the element never regains focus. The
 * dialog then looks alive (Esc still works, because the dialog host handles it)
 * while Enter is dead, because `SelectRenderable.handleKeyPress` only runs for
 * the focused renderable.
 *
 * Deferring past the current tick wins that race. Known ceiling: this only
 * covers focus stolen during mount. If a host ever steals focus later, the
 * element has to claim it again on that event.
 */
export function claimFocusOnMount(getElement: () => { focus: () => void } | undefined): void {
  onMount(() => {
    setTimeout(() => getElement()?.focus(), 0)
  })
}
