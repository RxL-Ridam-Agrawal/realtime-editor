/**
 * Renders the list of who's connected into `container` (a <ul>), reading
 * from awareness state's `user` field (the same field y-codemirror.next's
 * yRemoteSelections reads for cursor color/name).
 * @param {HTMLElement} container
 * @param {import('y-protocols/awareness').Awareness} awareness
 * @param {number} localClientId
 * @returns {() => void} cleanup
 */
export function createPresenceList (container, awareness, localClientId) {
  function render () {
    container.innerHTML = ''
    for (const [clientId, state] of awareness.getStates()) {
      if (!state?.user) continue
      const item = document.createElement('li')
      item.className = 'presence-item'

      const swatch = document.createElement('span')
      swatch.className = 'presence-swatch'
      swatch.style.backgroundColor = state.user.color

      const label = document.createElement('span')
      label.textContent = state.user.name + (clientId === localClientId ? ' (you)' : '')

      item.append(swatch, label)
      container.appendChild(item)
    }
  }

  awareness.on('change', render)
  render()

  return () => awareness.off('change', render)
}
