type IconProps = { active?: boolean }

const stroke = (active?: boolean) => (active ? 'var(--blue)' : 'currentColor')

export function DashboardIcon({ active }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke={stroke(active)} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 1 1 18 0" />
      <path d="M12 12l4.2-4.2" />
      <path d="M12 12l-4-1.4" />
    </svg>
  )
}

export function ListIcon({ active }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke={stroke(active)} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  )
}

export function TargetIcon({ active }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke={stroke(active)} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1" fill={stroke(active)} />
    </svg>
  )
}

export function MoreIcon({ active }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke={stroke(active)} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="5" cy="12" r="1.4" fill={stroke(active)} />
      <circle cx="12" cy="12" r="1.4" fill={stroke(active)} />
      <circle cx="19" cy="12" r="1.4" fill={stroke(active)} />
    </svg>
  )
}

export function CameraIcon({ active }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke={stroke(active)} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 8h3l1.5-2.5h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />
      <circle cx="12" cy="13.5" r="3.5" />
    </svg>
  )
}

export function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}

export function SortIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 4v16" />
      <path d="M3.5 7.5L7 4l3.5 3.5" />
      <path d="M17 20V4" />
      <path d="M13.5 16.5L17 20l3.5-3.5" />
    </svg>
  )
}
