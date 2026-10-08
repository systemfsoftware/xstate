import type { Meta, StoryObj } from '@storybook/react-vite'
import { useMemo } from 'react'
import {
  type AnyStoreConfig,
  type AnyStoreLogicCreator,
  type Atom,
  type AtomConfig,
  createAtom,
  createAtomConfig,
  createStore,
  createStoreHook,
  createStoreLogic,
  type Readable,
  type StoreInspectionEvent,
  type StoreSnapshot,
  useAtom,
  useAtomState,
  useSelector,
  useStore,
} from './index.js'

const countStore = () =>
  createStore({
    context: { count: 0 },
    on: {
      inc: (ctx: { count: number }) => ({ ...ctx, count: ctx.count + 1 }),
    },
  })

const countAtom = () => createAtom(0)

const countAtomConfig = () => createAtomConfig((input: { initialCount: number }) => input.initialCount)

const countLogic = () =>
  createStoreLogic({
    context: (input: { initialCount: number }) => ({ count: input.initialCount }),
    on: {
      inc: (ctx) => ({ count: ctx.count + 1 }),
    },
  })

const increments = (): AnyStoreConfig => ({
  context: { count: 0 },
  on: {
    inc: (ctx: { count: number }) => ({ ...ctx, count: ctx.count + 1 }),
  },
})

interface SelectorCounterProps {
  store: Readable<StoreSnapshot<{ count: number }>>
  selector: (snapshot: StoreSnapshot<{ count: number }>) => number
  compare?: (a: number, b: number) => boolean
  onClick: () => void
}

const SelectorCounter = ({ store, selector, compare, onClick }: SelectorCounterProps) => {
  const value = useSelector(store, selector, compare)
  return (
    <div data-testid='count' onClick={onClick}>
      {String(value)}
    </div>
  )
}

interface AtomSelectorCounterProps {
  store: Readable<number>
  selector: (snapshot: number) => number
  onClick: () => void
}

const AtomSelectorCounter = ({ store, selector, onClick }: AtomSelectorCounterProps) => {
  const value = useSelector(store, selector)
  return (
    <div data-testid='count' onClick={onClick}>
      {String(value)}
    </div>
  )
}

interface FullSnapshotCounterProps {
  store: Readable<{ context: { count: number } }>
}

const FullSnapshotCounter = ({ store }: FullSnapshotCounterProps) => {
  const snapshot = useSelector(store)
  return <div data-testid='count'>{snapshot.context.count}</div>
}

interface CompareOnlyCounterProps {
  store: Readable<{ count: number }>
  compare: (a: { count: number } | undefined, b: { count: number } | undefined) => boolean
  onRender?: () => void
}

const CompareOnlyCounter = ({ store, compare, onRender }: CompareOnlyCounterProps) => {
  onRender?.()
  const value = useSelector(store, undefined, compare)
  return <div data-testid='count'>{value.count}</div>
}

interface ConfigStoreCounterProps {
  definition: AnyStoreConfig
  selector: (snapshot: StoreSnapshot<{ count: number }>) => number
  inspect?: (event: StoreInspectionEvent) => void
  onStoreRef?: (store: object) => void
}

const ConfigStoreCounter = ({ definition, selector, inspect, onStoreRef }: ConfigStoreCounterProps) => {
  const store = useStore(definition, inspect === undefined ? undefined : { inspect })
  onStoreRef?.(store)
  const value = useSelector(store, selector)
  return (
    <div data-testid='count' onClick={() => store.send({ type: 'inc' })}>
      {String(value)}
    </div>
  )
}

interface InspectToggleCounterProps {
  definition: AnyStoreConfig
  inspect?: (event: StoreInspectionEvent) => void
}

const InspectToggleCounter = ({ definition, inspect }: InspectToggleCounterProps) => {
  const store = useStore(definition, inspect === undefined ? undefined : { inspect })
  return <button onClick={() => store.send({ type: 'inc' })}>inc</button>
}

interface LogicStoreCounterProps {
  logic: AnyStoreLogicCreator
  input: { initialCount: number }
  selector: (snapshot: StoreSnapshot<{ count: number }>) => number
  inspect?: (event: StoreInspectionEvent) => void
  onStoreRef?: (store: object) => void
}

const LogicStoreCounter = ({ logic, input, selector, inspect, onStoreRef }: LogicStoreCounterProps) => {
  const store = useStore(logic, input, inspect === undefined ? undefined : { inspect })
  onStoreRef?.(store)
  const value = useSelector(store, selector)
  return (
    <div data-testid='count' onClick={() => store.send({ type: 'inc' })}>
      {String(value)}
    </div>
  )
}

interface AtomCounterProps {
  atom: Atom<number>
}

const AtomCounter = ({ atom }: AtomCounterProps) => {
  const value = useAtom(atom)
  return (
    <div>
      <div data-testid='value'>{String(value)}</div>
      <button data-testid='increment' onClick={() => atom.set((count) => count + 1)}>
        +
      </button>
    </div>
  )
}

interface AtomConfigCounterProps {
  config: AtomConfig<number, { initialCount: number }>
  input: { initialCount: number }
}

const AtomConfigCounter = ({ config, input }: AtomConfigCounterProps) => {
  const value = useAtom(config, input)
  return <div data-testid='value'>{String(value)}</div>
}

interface AtomStateFromAtomCounterProps {
  atom: Atom<number>
  onAtomRef?: (atom: object) => void
}

const AtomStateFromAtomCounter = ({ atom, onAtomRef }: AtomStateFromAtomCounterProps) => {
  const [count, countAtom] = useAtomState(atom)
  onAtomRef?.(countAtom)
  return (
    <div>
      <div data-testid='count'>{String(count)}</div>
      <button data-testid='increment' onClick={() => countAtom.set((value) => value + 1)}>
        +
      </button>
    </div>
  )
}

interface AtomStateFromConfigCounterProps {
  config: AtomConfig<number, { initialCount: number }>
  input: { initialCount: number }
  onAtomRef?: (atom: object) => void
}

const AtomStateFromConfigCounter = ({ config, input, onAtomRef }: AtomStateFromConfigCounterProps) => {
  const [count, countAtom] = useAtomState(config, input)
  onAtomRef?.(countAtom)
  return (
    <div>
      <div data-testid='count'>{String(count)}</div>
      <button data-testid='increment' onClick={() => countAtom.set((value) => value + 1)}>
        +
      </button>
    </div>
  )
}

interface StoreHookCounterProps {
  definition: AnyStoreConfig
  selector: (snapshot: StoreSnapshot<{ count: number }>) => number
}

const StoreHookCounter = ({ definition, selector }: StoreHookCounterProps) => {
  const useCountStore = useMemo(() => createStoreHook(definition), [definition])
  const [count, store] = useCountStore(selector)
  return (
    <div>
      <div data-testid='count'>{String(count)}</div>
      <button onClick={() => store.send({ type: 'inc' })}>+</button>
    </div>
  )
}

const meta = {
  title: 'xstate-store-react/guarded fixtures',
} satisfies Meta

export default meta

export const SelectorStore: StoryObj<typeof SelectorCounter> = {
  render: (args) => <SelectorCounter {...args} />,
  args: {
    store: countStore(),
    selector: (snapshot) => snapshot.context.count,
    onClick: () => {},
  },
}

export const AtomSelectorStore: StoryObj<typeof AtomSelectorCounter> = {
  render: (args) => <AtomSelectorCounter {...args} />,
  args: {
    store: countAtom(),
    selector: (snapshot) => snapshot,
    onClick: () => {},
  },
}

export const FullSnapshotStore: StoryObj<typeof FullSnapshotCounter> = {
  render: (args) => <FullSnapshotCounter {...args} />,
  args: {
    store: createStore({ context: { count: 0 }, on: {} }),
  },
}

export const CompareOnlyStore: StoryObj<typeof CompareOnlyCounter> = {
  render: (args) => <CompareOnlyCounter {...args} />,
  args: {
    store: createAtom({ count: 0, ignored: 0 }),
    compare: (a, b) => a?.count === b?.count,
  },
}

export const ConfigStore: StoryObj<typeof ConfigStoreCounter> = {
  render: (args) => <ConfigStoreCounter {...args} />,
  args: {
    definition: increments(),
    selector: (snapshot) => snapshot.context.count,
  },
}

export const InspectToggleStore: StoryObj<typeof InspectToggleCounter> = {
  render: (args) => <InspectToggleCounter {...args} />,
  args: {
    definition: increments(),
  },
}

export const LogicStore: StoryObj<typeof LogicStoreCounter> = {
  render: (args) => <LogicStoreCounter {...args} />,
  args: {
    logic: countLogic(),
    input: { initialCount: 10 },
    selector: (snapshot) => snapshot.context.count,
  },
}

export const AtomStore: StoryObj<typeof AtomCounter> = {
  render: (args) => <AtomCounter {...args} />,
  args: {
    atom: countAtom(),
  },
}

export const AtomConfigStore: StoryObj<typeof AtomConfigCounter> = {
  render: (args) => <AtomConfigCounter {...args} />,
  args: {
    config: countAtomConfig(),
    input: { initialCount: 10 },
  },
}

export const AtomStateAtomStore: StoryObj<typeof AtomStateFromAtomCounter> = {
  render: (args) => <AtomStateFromAtomCounter {...args} />,
  args: {
    atom: countAtom(),
  },
}

export const AtomStateConfigStore: StoryObj<typeof AtomStateFromConfigCounter> = {
  render: (args) => <AtomStateFromConfigCounter {...args} />,
  args: {
    config: countAtomConfig(),
    input: { initialCount: 10 },
  },
}

export const StoreHookStore: StoryObj<typeof StoreHookCounter> = {
  render: (args) => <StoreHookCounter {...args} />,
  args: {
    definition: increments(),
    selector: (snapshot) => snapshot.context.count,
  },
}
