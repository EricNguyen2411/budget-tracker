import { useState } from 'react'

const CLOSE_DURATION = 240

/** Returns a requestClose function to use in place of onClose on the
 * backdrop and any internal Cancel/Done buttons, plus a closing flag to
 * append as a CSS class — React removes elements from the DOM instantly
 * when a condition goes false, so animating an exit means holding the
 * element in place for one more moment while a "closing" class drives
 * the transition, then calling the real onClose once it's done. */
export function useModalClose(onClose: () => void) {
  const [closing, setClosing] = useState(false)

  function requestClose(action?: () => void) {
    if (closing) return
    setClosing(true)
    setTimeout(action ?? onClose, CLOSE_DURATION)
  }

  return { closing, requestClose }
}
