import { onMount } from 'solid-js'

export function claimFocusOnMount(getElement: () => { focus: () => void } | undefined): void {
  onMount(() => {
    setTimeout(() => getElement()?.focus(), 0)
  })
}
