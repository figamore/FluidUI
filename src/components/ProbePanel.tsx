import { useEffect, useRef, useState } from 'react'
import { ChevronDown, CircleDot, Crosshair, Pause, Play, Square, Target } from 'lucide-react'
import {
  onLine,
  onSoftReset,
  resumeBackgroundTraffic,
  sendRaw,
  sendRealtime,
  suspendBackgroundTraffic,
} from '../lib/ws'
import { useMachineStore } from '../store'
import { useManualAtcStore } from '../store/manualAtc'
import { displayToMm, feedUnitLabel, linearUnitLabel, mmToDisplay } from '../lib/units'
import { parseProbePoint, type ProbePoint } from '../lib/fluidncReports'

type Axis = 'X' | 'Y' | 'Z'
type Side = 'negative' | 'positive'
type CycleId = 'z-surface' | 'x-negative' | 'x-positive' | 'y-negative' | 'y-positive'
  | 'x-center' | 'y-center' | 'bore-center' | 'rectangle-center'

interface RunningCycle { id: CycleId; phase: string; first?: number }
type ProbeStepState = 'idle' | 'pending' | 'active' | 'completed'

const PROBE_ALARM_MESSAGES: Record<number, string> = {
  1: 'Hard limit triggered',
  2: 'Soft limit exceeded',
  3: 'Cycle aborted',
  4: 'Probe fail — initial state',
  5: 'Probe fail — no contact',
  13: 'Hard stop',
  14: 'Machine is unhomed',
  17: 'G-code command error',
  18: 'Probe hard limit',
}

const CYCLES: Array<{ id: CycleId; label: string; short: string; group: 'edge' | 'center' }> = [
  { id: 'z-surface', label: 'Z surface', short: 'Z−', group: 'edge' },
  { id: 'x-negative', label: 'Probe X−', short: 'X−', group: 'edge' },
  { id: 'x-positive', label: 'Probe X+', short: 'X+', group: 'edge' },
  { id: 'y-negative', label: 'Probe Y−', short: 'Y−', group: 'edge' },
  { id: 'y-positive', label: 'Probe Y+', short: 'Y+', group: 'edge' },
  { id: 'x-center', label: 'X center', short: 'X ⊕', group: 'center' },
  { id: 'y-center', label: 'Y center', short: 'Y ⊕', group: 'center' },
  { id: 'bore-center', label: 'Bore center', short: '○ ⊕', group: 'center' },
  { id: 'rectangle-center', label: 'Rectangle center', short: '▭ ⊕', group: 'center' },
]

const CYCLE_INSTRUCTIONS: Record<CycleId, string> = {
  'z-surface': 'Position the probe above the touch plate or work surface, then verify the plate thickness.',
  'x-negative': 'Position the probe on the X+ side of the target face with a clear path for X− travel.',
  'x-positive': 'Position the probe on the X− side of the target face with a clear path for X+ travel.',
  'y-negative': 'Position the probe on the Y+ side of the target face with a clear path for Y− travel.',
  'y-positive': 'Position the probe on the Y− side of the target face with a clear path for Y+ travel.',
  'x-center': 'Start between the opposing X faces near center, with both faces within the configured travel.',
  'y-center': 'Start between the opposing Y faces near center, with both faces within the configured travel.',
  'bore-center': 'Start inside the bore near center. The cycle touches X−/X+, centers X, then touches Y−/Y+ and sets X0 Y0.',
  'rectangle-center': 'Start inside the feature near center. The cycle touches X−/X+, centers X, then touches Y−/Y+ and sets X0 Y0.',
}

const TOOLSETTER_ONLY_HINT = 'Only a toolsetter is configured. Only Z-height setting is available; X/Y and center probing require a probe input.'

function usePersisted<T>(key: string, init: T): [T, (v: T) => void] {
  const [val, setVal] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      if (raw !== null) return JSON.parse(raw) as T
    } catch { /* use default */ }
    return init
  })
  function persist(v: T) {
    localStorage.setItem(key, JSON.stringify(v))
    setVal(v)
  }
  return [val, persist]
}

function number(value: number) {
  return Number.isFinite(value) ? Number(value.toFixed(4)) : 0
}

function alarmMessageFromLine(line: string): string | null {
  const activeAlarm = line.match(/^Active alarm:\s*(\d+)\s*(?:\(([^)]+)\))?/i)
  if (activeAlarm) {
    const code = Number(activeAlarm[1])
    return activeAlarm[2]?.trim() || PROBE_ALARM_MESSAGES[code] || `Controller alarm ${code}`
  }

  const alarmCode = line.match(/^ALARM:(\d+)$/i)
    || line.match(/^<Alarm(?::(\d+))?(?:[|>])/i)
  if (alarmCode) {
    const code = Number(alarmCode[1])
    return PROBE_ALARM_MESSAGES[code] || (Number.isFinite(code) ? `Controller alarm ${code}` : 'Controller alarm')
  }

  const namedAlarm = line.match(/\[MSG:(?:INFO|ERR):\s*ALARM:\s*(.+?)\]/i)
  return namedAlarm?.[1]?.trim() || null
}

function axisValue(point: ProbePoint, axis: Axis) {
  return point[axis.toLowerCase() as keyof ProbePoint]
}

function moveWord(axis: Axis, side: Side, distance: number) {
  return `${axis}${side === 'negative' ? '-' : ''}${number(distance)}`
}

function ProbeGraphic({
  cycle,
  running,
  held,
  cycleCompleted,
}: {
  cycle: CycleId
  running?: RunningCycle | null
  held?: boolean
  cycleCompleted?: boolean
}) {
  const isZ = cycle === 'z-surface'
  const isBore = cycle === 'bore-center'
  const isRectangle = cycle === 'rectangle-center'
  const centerAxis = cycle === 'x-center' ? 'X' : cycle === 'y-center' ? 'Y' : null
  const side = cycle.includes('negative') ? 'negative' : 'positive'
  const axis = cycle.startsWith('x-') ? 'X' : cycle.startsWith('y-') ? 'Y' : null
  const horizontal = axis === 'X'
  const arrow = side === 'negative'
    ? horizontal ? 'M68 60 H39' : 'M60 68 V39'
    : horizontal ? 'M52 60 H81' : 'M60 52 V81'
  const edgeProbeX = horizontal ? (side === 'negative' ? 78 : 42) : 60
  const edgeProbeY = horizontal ? 60 : (side === 'negative' ? 78 : 42)
  const id = cycle.replace(/-/g, '')

  function activeCenterStep() {
    if (!running || running.id !== cycle) return null
    const bothAxes = cycle === 'bore-center' || cycle === 'rectangle-center'
    if (running.phase === 'x-negative') return 1
    if (running.phase === 'x-positive') return 2
    if (running.phase === 'y-negative') return bothAxes ? 3 : 1
    if (running.phase === 'y-positive') return bothAxes ? 4 : 2
    return null
  }

  const currentStep = activeCenterStep()

  function stepState(step: number): ProbeStepState {
    if (cycleCompleted) return 'completed'
    if (currentStep == null) return 'idle'
    if (step < currentStep) return 'completed'
    if (step === currentStep) return 'active'
    return 'pending'
  }

  const TopProbe = ({ x = 60, y = 60 }: { x?: number; y?: number }) => <g>
    <circle cx={x} cy={y} r="10" fill={`url(#probeMetal${id})`} stroke="var(--text-muted)" strokeWidth="1.2" />
    <circle cx={x} cy={y} r="6.5" fill="var(--surface)" stroke="var(--border-strong)" />
    <circle cx={x} cy={y} r="2.7" fill="var(--accent)" />
    <path d={`M${x - 4} ${y - 4} L${x + 4} ${y + 4} M${x + 4} ${y - 4} L${x - 4} ${y + 4}`}
      stroke="var(--text-dim)" strokeWidth=".7" />
  </g>

  const Datum = ({ x, y, label }: { x: number; y: number; label: string }) => <g>
    <circle cx={x} cy={y} r="3.7" fill="var(--surface)" stroke="var(--ok)" strokeWidth="1.6" />
    <circle cx={x} cy={y} r="1.4" fill="var(--ok)" />
    <text x={x + 5} y={y - 5} fill="var(--ok)" fontSize="8" fontWeight="700">{label}</text>
  </g>

  const SequenceBadge = ({ x, y, value }: { x: number; y: number; value: number }) => {
    const state = stepState(value)
    const color = state === 'completed'
      ? 'var(--ok)'
      : state === 'pending' ? 'var(--text-dim)' : 'var(--accent)'
    const fill = state === 'completed'
      ? 'rgb(var(--ok-rgb) / .16)'
      : state === 'active' ? 'rgb(var(--accent-rgb) / .14)' : 'var(--surface)'
    return <g>
      {state === 'active' && !held && <circle className="probe-step-pulse" cx={x} cy={y} r="9.5" fill="none" stroke="var(--accent)" strokeWidth="1.4" />}
      {state === 'active' && held && <circle cx={x} cy={y} r="9.5" fill="none" stroke="var(--warn)" strokeWidth="1" opacity=".45" />}
      <circle cx={x} cy={y} r="7.5" fill={fill} stroke={color} strokeWidth={state === 'active' ? 2 : 1.4} />
      <text x={x} y={y + 3.5} textAnchor="middle" fill={color} fontSize="10" fontWeight="800">{value}</text>
    </g>
  }

  return (
    <svg viewBox="0 0 120 120" className="w-full h-full" role="img" aria-label={`${cycle} probing diagram`}>
      <defs>
        <marker id={`probe-arrow-${cycle}`} markerWidth="7" markerHeight="7" refX="5.5" refY="3.5" orient="auto">
          <path d="M0 0 L7 3.5 L0 7Z" fill="var(--accent)" />
        </marker>
        <marker id={`axis-x-${id}`} markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto">
          <path d="M0 0 L5 2.5 L0 5Z" fill="#ef4444" />
        </marker>
        <marker id={`axis-y-${id}`} markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto">
          <path d="M0 0 L5 2.5 L0 5Z" fill="#22c55e" />
        </marker>
        <marker id={`axis-z-${id}`} markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto">
          <path d="M0 0 L5 2.5 L0 5Z" fill="#3b82f6" />
        </marker>
        <linearGradient id={`probeMetal${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--surface)" />
          <stop offset=".48" stopColor="var(--border-strong)" />
          <stop offset="1" stopColor="var(--elevated)" />
        </linearGradient>
        <linearGradient id={`probePart${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--elevated)" />
          <stop offset="1" stopColor="var(--border)" />
        </linearGradient>
        <pattern id={`probeHatch${id}`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="6" height="6" fill={`url(#probePart${id})`} />
          <path d="M0 0 V6" stroke="var(--border-strong)" strokeWidth="1" opacity=".45" />
        </pattern>
        <filter id={`probeShadow${id}`} x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="2" stdDeviation="2" floodColor="#000" floodOpacity=".22" />
        </filter>
      </defs>
      <rect x="1" y="1" width="118" height="118" rx="8" fill="rgb(var(--accent-rgb) / .035)" stroke="var(--border)" />
      {axis && !centerAxis && <>
        <path d="M12 108 H31" stroke="#ef4444" strokeWidth="1.2" markerEnd={`url(#axis-x-${id})`} />
        <path d="M12 108 V89" stroke="#22c55e" strokeWidth="1.2" markerEnd={`url(#axis-y-${id})`} />
        <text x="35" y="111" fill="var(--text-dim)" fontSize="8">X+</text>
        <text x="4" y="84" fill="var(--text-dim)" fontSize="8">Y+</text>
      </>}
      {isZ ? <>
        <path d="M13 84 H107 V104 H13Z" fill={`url(#probeHatch${id})`} stroke="var(--border-strong)" />
        <path d="M13 84 H107" stroke="var(--ok)" strokeWidth="2" />
        <path d="M20 84 L27 77 H100 L93 84Z" fill="rgb(var(--accent-rgb) / .14)" stroke="var(--accent)" strokeWidth="1" />
        <TopProbe x={60} y={35} />
        <path d="M60 45 V81" stroke="var(--accent)" strokeWidth="2.5" strokeDasharray="5 3" markerEnd={`url(#probe-arrow-${cycle})`} />
        <text x="67" y="62" fill="var(--accent)" fontSize="9" fontWeight="800">Z−</text>
        <Datum x={60} y={84} label="Z0" />
        <path d="M101 77 V84 M97 77 H105 M97 84 H105" stroke="var(--text-muted)" strokeWidth=".9" />
        <text x="82" y="73" fill="var(--text-muted)" fontSize="8" fontWeight="700">PLATE</text>
      </> : isBore || isRectangle ? <>
        {isBore ? <>
          <circle cx="60" cy="60" r="46" fill={`url(#probeHatch${id})`} stroke="var(--border-strong)" />
          <circle cx="60" cy="60" r="35" fill="var(--surface)" stroke="var(--text-muted)" strokeWidth="1.2" />
        </> : <>
          <rect x="10" y="10" width="100" height="100" rx="4" fill={`url(#probeHatch${id})`} stroke="var(--border-strong)" />
          <rect x="22" y="22" width="76" height="76" rx="3" fill="var(--surface)" stroke="var(--text-muted)" strokeWidth="1.2" />
        </>}
        <path d="M27 60 H49 M93 60 H71 M60 27 V49 M60 93 V71" stroke="var(--accent)" strokeWidth="2" strokeDasharray="3 2" />
        <path d="M49 60 L44 57 V63Z M71 60 L76 57 V63Z M60 49 L57 44 H63Z M60 71 L57 76 H63Z" fill="var(--accent)" />
        <circle cx="60" cy="60" r="15" fill="rgb(var(--accent-rgb) / .07)" stroke="var(--accent)" strokeDasharray="2 2" />
        <TopProbe x={60} y={60} />
        <path d="M48 60 H72 M60 48 V72" stroke="var(--ok)" strokeWidth=".8" />
        <SequenceBadge x={18} y={60} value={1} />
        <SequenceBadge x={102} y={60} value={2} />
        <SequenceBadge x={60} y={18} value={4} />
        <SequenceBadge x={60} y={102} value={3} />
      </> : centerAxis ? <>
        <rect x="10" y="10" width="100" height="100" rx="4" fill={`url(#probeHatch${id})`} stroke="var(--border-strong)" />
        <rect x="22" y="22" width="76" height="76" rx="3" fill="var(--surface)" stroke="var(--text-muted)" strokeWidth="1.2" />
        {centerAxis === 'X'
          ? <><path d="M27 60 H49 M93 60 H71" stroke="var(--accent)" strokeWidth="2" strokeDasharray="3 2" />
            <path d="M49 60 L44 57 V63Z M71 60 L76 57 V63Z" fill="var(--accent)" /></>
          : <><path d="M60 27 V49 M60 93 V71" stroke="var(--accent)" strokeWidth="2" strokeDasharray="3 2" />
            <path d="M60 49 L57 44 H63Z M60 71 L57 76 H63Z" fill="var(--accent)" /></>}
        <TopProbe x={60} y={60} />
        <path d={centerAxis === 'X' ? 'M44 60 H76 M60 52 V68' : 'M52 60 H68 M60 43 V77'} stroke="var(--ok)" strokeWidth=".8" />
        <SequenceBadge x={centerAxis === 'X' ? 29 : 74} y={centerAxis === 'X' ? 48 : 29} value={1} />
        <SequenceBadge x={centerAxis === 'X' ? 91 : 74} y={centerAxis === 'X' ? 48 : 91} value={2} />
      </> : <>
        <path d={horizontal
          ? side === 'negative' ? 'M17 18 H40 V102 H17Z' : 'M80 18 H103 V102 H80Z'
          : side === 'negative' ? 'M18 17 H102 V40 H18Z' : 'M18 80 H102 V103 H18Z'}
          fill={`url(#probeHatch${id})`} stroke="var(--border-strong)" />
        <path d={horizontal
          ? `M${side === 'negative' ? 40 : 80} 18 V102`
          : `M18 ${side === 'negative' ? 40 : 80} H102`} stroke="var(--ok)" strokeWidth="1.8" />
        <TopProbe x={edgeProbeX} y={edgeProbeY} />
        <path d={arrow} stroke="var(--accent)" strokeWidth="2.4" strokeDasharray="4 2" markerEnd={`url(#probe-arrow-${cycle})`} />
        <circle cx={horizontal ? (side === 'negative' ? 40 : 80) : 60} cy={horizontal ? 60 : (side === 'negative' ? 40 : 80)}
          r="3.2" fill="var(--surface)" stroke="var(--ok)" strokeWidth="1.5" />
        <text x={horizontal ? (side === 'negative' ? 20 : 85) : 69} y={horizontal ? 55 : (side === 'negative' ? 32 : 94)}
          fill="var(--ok)" fontSize="8.5" fontWeight="700">{axis}0</text>
        <text x={horizontal ? 54 : 72} y={horizontal ? 49 : (side === 'negative' ? 52 : 76)} fill="var(--accent)" fontSize="8" fontWeight="700">
          {axis}{side === 'negative' ? '−' : '+'}
        </text>
      </>}
    </svg>
  )
}

interface ParamRowProps {
  label: string; value: number; onChange: (v: number) => void; unit: string
  min?: number; isTablet?: boolean
}

function ParamRow({ label, value, onChange, unit, min = 0, isTablet }: ParamRowProps) {
  const [draftValue, setDraftValue] = useState(() => String(value))

  useEffect(() => {
    setDraftValue(String(value))
  }, [value])

  function commitValue() {
    const parsed = Number(draftValue.trim().replace(',', '.'))
    if (Number.isFinite(parsed) && parsed >= min) onChange(parsed)
    else setDraftValue(String(value))
  }

  return (
    <div className="flex items-center justify-between gap-3">
      <span className={`text-text-muted font-semibold shrink-0 ${isTablet ? 'text-lg' : 'text-sm'}`}>{label}</span>
      <span className="flex items-center gap-1.5">
        <input type="text" inputMode="decimal" aria-label={label} value={draftValue}
          onChange={e => setDraftValue(e.target.value)} onBlur={commitValue}
          onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
          className={`input-field font-mono text-right ${isTablet ? 'w-36 py-2 text-xl' : 'w-28 py-1 text-base'}`} />
        <span className={`text-text-dim shrink-0 ${isTablet ? 'text-lg w-20' : 'text-sm w-14'}`}>{unit}</span>
      </span>
    </div>
  )
}

function toDisplayInput(value: number, units: 'mm' | 'in', decimals: number) {
  return Number(mmToDisplay(value, units).toFixed(decimals))
}

export function ProbePanel({ isTablet, embedded = false }: { isTablet?: boolean; embedded?: boolean }) {
  const reportedHasProbe = useMachineStore(s => s.controllerSettings.hasProbe)
  const reportedHasToolsetter = useMachineStore(s => s.controllerSettings.hasToolsetter)
  const hasManualATC = useMachineStore(s => s.controllerSettings.hasManualATC === true)
  const hasProbingInput = reportedHasProbe === true || reportedHasToolsetter === true
  const toolsetterOnly = reportedHasProbe === false && reportedHasToolsetter === true
  const [open, setOpen] = useState(embedded)
  const [selected, setSelected] = usePersisted<CycleId>('probe.cycle', 'z-surface')
  const [running, setRunning] = useState<RunningCycle | null>(null)
  const [probeHeld, setProbeHeld] = useState(false)
  const [completedCycle, setCompletedCycle] = useState<CycleId | null>(null)
  const runningRef = useRef<RunningCycle | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const backgroundPausedRef = useRef(false)
  const [message, setMessage] = useState(() => CYCLE_INSTRUCTIONS[selected])
  const [probeFeed, setProbeFeed] = usePersisted('probe.feed', 100)
  const [maxTravel, setMaxTravel] = usePersisted('probe.travel', 50)
  const [retract, setRetract] = usePersisted('probe.retract', 3)
  const [plateThick, setPlateThick] = usePersisted('probe.plate', 0)
  const [probeDiameter, setProbeDiameter] = usePersisted('probe.diameter', 4)
  const status = useMachineStore(s => s.status)
  const units = useMachineStore(s => s.units)
  const connected = useMachineStore(s => s.connected)
  const resetToolReference = useManualAtcStore(s => s.resetReference)
  const completeReferenceSetup = useManualAtcStore(s => s.completeReferenceSetup)
  const canProbe = connected && status.state === 'Idle'

  function updateRun(next: RunningCycle | null) {
    runningRef.current = next
    setRunning(next)
    if (!next) setProbeHeld(false)
  }

  function selectCycle(cycle: CycleId) {
    if (runningRef.current || (toolsetterOnly && cycle !== 'z-surface')) return
    setSelected(cycle)
    setCompletedCycle(null)
    setMessage(CYCLE_INSTRUCTIONS[cycle])
  }

  useEffect(() => {
    if (toolsetterOnly && selected !== 'z-surface' && !runningRef.current) {
      selectCycle('z-surface')
    }
  }, [toolsetterOnly, selected])

  function pauseBackgroundTraffic() {
    if (backgroundPausedRef.current) return
    backgroundPausedRef.current = true
    suspendBackgroundTraffic()
  }

  function restoreBackgroundTraffic() {
    if (!backgroundPausedRef.current) return
    backgroundPausedRef.current = false
    resumeBackgroundTraffic()
  }

  function armTimeout() {
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = setTimeout(() => {
      restoreBackgroundTraffic()
      updateRun(null)
      setMessage('No probe contact report received. Check the probe and controller state.')
    }, 90_000)
  }

  function probe(axis: Axis, side: Side, distance = maxTravel) {
    sendRaw(`G21 G91 G38.2 F${number(probeFeed)} ${moveWord(axis, side, distance)}`)
    armTimeout()
  }

  function finish(messageText: string, markCycleCompleted = false) {
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = null
    if (markCycleCompleted && runningRef.current) setCompletedCycle(runningRef.current.id)
    restoreBackgroundTraffic()
    updateRun(null)
    setMessage(messageText)
  }

  function finishAxisCenter(axis: Axis, first: number, second: number, continueWithY: boolean) {
    const midpoint = number((first + second) / 2)
    sendRaw(`G21 G91 G0 ${moveWord(axis, 'negative', retract)}`)
    sendRaw(`G90 G53 G0 ${axis}${midpoint}`)
    sendRaw(`G10 L20 P0 ${axis}0`)
    if (continueWithY) {
      const next = { id: runningRef.current!.id, phase: 'y-negative' }
      updateRun(next)
      setMessage('Points 1–2 complete. Point 3/4 — probing Y−…')
      probe('Y', 'negative')
    } else {
      sendRaw('G90')
      const featureCenter = runningRef.current?.id === 'bore-center' || runningRef.current?.id === 'rectangle-center'
      finish(featureCenter
        ? 'Feature center found and X/Y work zero set.'
        : `${axis} center found and ${axis} work zero set.`, true)
    }
  }

  useEffect(() => onLine(line => {
    const active = runningRef.current
    if (!active) return

    const alarmMessage = alarmMessageFromLine(line)
    if (alarmMessage) {
      finish(`Probe cycle stopped — ${alarmMessage}.`)
      return
    }

    const commandError = line.match(/^error:(\d+)$/i)
    if (commandError) {
      finish(`Probe command rejected by the controller (error ${commandError[1]}).`)
      return
    }

    const point = parseProbePoint(line)
    if (!point) return
    const radius = probeDiameter / 2

    if (active.id === 'z-surface') {
      sendRaw(`G10 L20 P0 Z${number(plateThick)}`)
      sendRaw(`G21 G91 G0 Z${number(retract)}`)
      sendRaw('G90')
      const referenceRegistered = !hasManualATC || completeReferenceSetup()
      finish(hasManualATC && referenceRegistered
        ? 'Z surface captured and the installed tool is now the tool-change reference.'
        : hasManualATC
          ? 'Z surface captured, but the tool-change reference could not be registered.'
          : 'Z surface captured and work offset updated.')
      return
    }

    const edgeMatch = active.id.match(/^([xy])-(negative|positive)$/)
    if (edgeMatch) {
      const axis = edgeMatch[1].toUpperCase() as Axis
      const side = edgeMatch[2] as Side
      const compensatedCoordinate = side === 'negative' ? radius : -radius
      sendRaw(`G10 L20 P0 ${axis}${number(compensatedCoordinate)}`)
      sendRaw(`G21 G91 G0 ${moveWord(axis, side === 'negative' ? 'positive' : 'negative', retract)}`)
      sendRaw('G90')
      finish(`${axis}${side === 'negative' ? '−' : '+'} edge captured with probe-radius compensation.`)
      return
    }

    const axis = active.phase.startsWith('x-') ? 'X' : 'Y'
    if (active.phase.endsWith('negative')) {
      const first = axisValue(point, axis)
      sendRaw(`G21 G91 G0 ${moveWord(axis, 'positive', retract)}`)
      const next = { ...active, phase: `${axis.toLowerCase()}-positive`, first }
      updateRun(next)
      const bothAxes = active.id === 'bore-center' || active.id === 'rectangle-center'
      const pointNumber = axis === 'Y' && bothAxes ? 4 : 2
      const total = bothAxes ? 4 : 2
      setMessage(`Point ${pointNumber - 1} complete. Point ${pointNumber}/${total} — probing ${axis}+…`)
      probe(axis, 'positive', maxTravel * 2)
      return
    }

    const second = axisValue(point, axis)
    const bothAxes = active.id === 'bore-center' || active.id === 'rectangle-center'
    finishAxisCenter(axis, active.first!, second, bothAxes && axis === 'X')
  }), [completeReferenceSetup, hasManualATC, maxTravel, plateThick, probeDiameter, probeFeed, retract])

  useEffect(() => onSoftReset(() => {
    if (!runningRef.current) return
    finish('Probe cycle aborted by controller reset.')
  }), [])

  useEffect(() => {
    if (!runningRef.current || status.state !== 'Alarm') return
    const alarmMessage = status.alarmName
      || (status.alarmCode != null ? PROBE_ALARM_MESSAGES[status.alarmCode] : undefined)
      || 'Controller alarm'
    finish(`Probe cycle stopped — ${alarmMessage}.`)
  }, [status.state, status.alarmCode, status.alarmName])

  useEffect(() => {
    if (connected || !runningRef.current) return
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = null
    restoreBackgroundTraffic()
    updateRun(null)
    setMessage('Probe cycle interrupted because the controller disconnected.')
  }, [connected])

  useEffect(() => () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    if (backgroundPausedRef.current) {
      backgroundPausedRef.current = false
      resumeBackgroundTraffic()
    }
  }, [])

  function runProbe() {
    if (!canProbe || running || (toolsetterOnly && selected !== 'z-surface')
      || probeFeed <= 0 || maxTravel <= 0 || retract <= 0) return
    setCompletedCycle(null)
    if (selected === 'z-surface' && hasManualATC && !resetToolReference()) {
      setMessage('Could not reset the tool-change reference before probing.')
      return
    }
    pauseBackgroundTraffic()
    const edge = selected.match(/^([xy])-(negative|positive)$/)
    if (selected === 'z-surface') {
      updateRun({ id: selected, phase: 'z-negative' })
      setMessage('Probing Z− toward the work surface…')
      probe('Z', 'negative')
    } else if (edge) {
      const axis = edge[1].toUpperCase() as Axis
      const side = edge[2] as Side
      updateRun({ id: selected, phase: `${axis.toLowerCase()}-${side}` })
      setMessage(`Probing ${axis}${side === 'negative' ? '−' : '+'}…`)
      probe(axis, side)
    } else {
      const axis: Axis = selected === 'y-center' ? 'Y' : 'X'
      const total = selected === 'bore-center' || selected === 'rectangle-center' ? 4 : 2
      updateRun({ id: selected, phase: `${axis.toLowerCase()}-negative` })
      setMessage(`Point 1/${total} — probing ${axis}−…`)
      probe(axis, 'negative')
    }
  }

  function holdProbe() {
    sendRealtime(0x21)
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = null
    restoreBackgroundTraffic()
    setProbeHeld(true)
  }

  function resumeProbe() {
    if (!runningRef.current) return
    pauseBackgroundTraffic()
    sendRealtime(0x7e)
    setProbeHeld(false)
    armTimeout()
  }

  function abortProbe() {
    if (!runningRef.current) return
    if (!confirm('Abort probing and reset the controller? Machine position may be lost.')) return
    sendRealtime(0x18)
  }

  const selectedCycle = CYCLES.find(c => c.id === selected)!
  const usesDiameter = selected !== 'z-surface'
  const selectedCycleUnavailable = toolsetterOnly && selected !== 'z-surface'
  const canRunSelectedCycle = canProbe && !selectedCycleUnavailable

  if (!hasProbingInput) return null

  return (
    <div className={embedded ? '' : 'panel'}>
      {!embedded && <button className="panel-header w-full justify-between cursor-pointer hover:bg-elevated/50 transition-colors"
        onClick={() => setOpen(v => !v)} aria-expanded={open}>
        <div className="flex items-center gap-2">
          <Target size={isTablet ? 20 : 15} />
          <span className="text-lg font-semibold">Probing</span>
        </div>
        <ChevronDown size={isTablet ? 20 : 15} className={`transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>}

      {open && <div className={`p-4 ${isTablet ? 'space-y-5' : 'space-y-4'}`}>
        <div>
          <div className="text-[13px] font-bold uppercase tracking-[.12em] text-text-dim mb-2">Single surface</div>
          <div className="grid grid-cols-5 gap-2">
            {CYCLES.filter(c => c.group === 'edge').map(c => <button key={c.id} onClick={() => selectCycle(c.id)}
              disabled={!!running || (toolsetterOnly && c.id !== 'z-surface')}
              title={toolsetterOnly && c.id !== 'z-surface' ? TOOLSETTER_ONLY_HINT : c.label}
              className={`btn justify-center font-mono ${isTablet ? 'h-14 text-xl' : 'h-10 text-base'} ${selected === c.id ? 'btn-primary' : 'btn-ghost'}`}>
              {c.short}
            </button>)}
          </div>
        </div>
        <div>
          <div className="text-[13px] font-bold uppercase tracking-[.12em] text-text-dim mb-2">Center finding</div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {CYCLES.filter(c => c.group === 'center').map(c => <button key={c.id} onClick={() => selectCycle(c.id)}
              disabled={!!running || toolsetterOnly}
              title={toolsetterOnly ? TOOLSETTER_ONLY_HINT : c.label}
              className={`btn min-w-0 justify-center whitespace-normal text-center leading-tight ${isTablet ? 'h-14 text-xl' : 'min-h-10 h-auto py-2 text-sm sm:h-10 sm:py-0 sm:text-base'} ${selected === c.id ? 'btn-primary' : 'btn-ghost'}`}>
              {c.label}
            </button>)}
          </div>
        </div>

        <div className={`grid grid-cols-1 gap-4 ${isTablet ? 'sm:grid-cols-[220px_1fr]' : 'sm:grid-cols-[150px_1fr]'}`}>
          <div className={`mx-auto w-full ${isTablet ? 'h-[220px] max-w-[220px]' : 'h-[220px] max-w-[220px] sm:h-[150px] sm:max-w-[150px]'}`}>
            <ProbeGraphic
              cycle={selected}
              running={running}
              held={probeHeld}
              cycleCompleted={completedCycle === selected}
            />
          </div>
          <div className={`rounded-md border border-border bg-elevated/30 p-3 ${isTablet ? 'space-y-4' : 'space-y-2'}`}>
            <ParamRow isTablet={isTablet} label="Probe feed" value={toDisplayInput(probeFeed, units, units === 'in' ? 2 : 0)}
              onChange={v => setProbeFeed(displayToMm(v, units))} unit={feedUnitLabel(units)} min={units === 'in' ? .1 : 1} />
            <ParamRow isTablet={isTablet} label="Max travel" value={toDisplayInput(maxTravel, units, units === 'in' ? 3 : 1)}
              onChange={v => setMaxTravel(displayToMm(v, units))} unit={linearUnitLabel(units)} min={units === 'in' ? .1 : 1} />
            <ParamRow isTablet={isTablet} label="Retract" value={toDisplayInput(retract, units, units === 'in' ? 4 : 2)}
              onChange={v => setRetract(displayToMm(v, units))} unit={linearUnitLabel(units)} min={units === 'in' ? .01 : .5} />
            {usesDiameter && <ParamRow isTablet={isTablet} label="Probe diameter" value={toDisplayInput(probeDiameter, units, units === 'in' ? 4 : 2)}
              onChange={v => setProbeDiameter(displayToMm(v, units))} unit={linearUnitLabel(units)} min={0} />}
            {!usesDiameter && <ParamRow isTablet={isTablet} label="Plate thickness" value={toDisplayInput(plateThick, units, units === 'in' ? 4 : 2)}
              onChange={v => setPlateThick(displayToMm(v, units))} unit={linearUnitLabel(units)} min={0} />}
          </div>
        </div>

        <div className={`flex items-center gap-3 rounded-md border px-3 py-2 ${running ? 'border-warn/40 bg-warn/5 text-warn' : 'border-border bg-elevated/20 text-text-muted'}`}>
          {running ? <CircleDot className="shrink-0" size={18} /> : <Crosshair className="shrink-0" size={18} />}
          <span className={`${isTablet ? 'text-xl' : 'text-base'} flex-1`}>{message}</span>
        </div>

        <div className="flex gap-2">
          <button className={`btn flex-1 justify-center font-semibold gap-2 ${isTablet ? 'h-16 text-xl' : 'h-11 text-base'} ${canRunSelectedCycle && !running ? 'btn-warn' : 'btn-ghost'}`}
            onClick={runProbe} disabled={!canRunSelectedCycle || !!running}>
            <Target size={isTablet ? 22 : 17} />
            {running ? probeHeld ? 'Cycle held' : 'Cycle active' : selectedCycleUnavailable ? 'General probe required' : canProbe ? `Run ${selectedCycle.label}` : connected ? 'Machine not Idle' : 'Controller offline'}
          </button>
          {running && !probeHeld && <button
            className={`btn btn-danger justify-center gap-2 ${isTablet ? 'h-16 px-6 text-xl' : 'h-11 px-4'}`}
            onClick={holdProbe}>
            <Pause size={isTablet ? 22 : 17} /> Feed hold
          </button>}
          {running && probeHeld && <>
            <button className={`btn btn-ok justify-center gap-2 ${isTablet ? 'h-16 px-6 text-xl' : 'h-11 px-4'}`} onClick={resumeProbe}>
              <Play size={isTablet ? 22 : 17} /> Resume
            </button>
            <button className={`btn btn-danger justify-center gap-2 ${isTablet ? 'h-16 px-6 text-xl' : 'h-11 px-4'}`} onClick={abortProbe}>
              <Square className="fill-current" size={isTablet ? 20 : 15} /> Abort
            </button>
          </>}
        </div>
      </div>}
    </div>
  )
}
