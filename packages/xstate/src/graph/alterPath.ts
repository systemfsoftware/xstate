import { XSTATE_INIT } from '../constants.js'
import type { EventObject } from '../index.js'
import type { AnySnapshot, StatePath, Steps } from './types.js'

type ErasedStatePath = StatePath<AnySnapshot, EventObject>
type ErasedSteps = Steps<AnySnapshot, EventObject>
type ErasedStep = ErasedSteps[number]

const initStepOf = (state: AnySnapshot): ErasedStep => ({
  state,
  event: { type: XSTATE_INIT },
})

const previousStepOf = (steps: ErasedSteps, index: number): ErasedStep | undefined => steps[index - 1]

const eventForStep = (steps: ErasedSteps, index: number): EventObject => {
  const previous = previousStepOf(steps, index)
  return previous === undefined ? { type: XSTATE_INIT } : previous.event
}

const replaySteps = (path: ErasedStatePath): ErasedSteps =>
  path.steps.flatMap((step, index) => [{ state: step.state, event: eventForStep(path.steps, index) }])

const finalStepOf = (path: ErasedStatePath): ErasedStep | undefined => {
  const last = path.steps[path.steps.length - 1]
  return last === undefined ? undefined : { state: path.state, event: last.event }
}

const appendedSteps = (path: ErasedStatePath): ErasedSteps => {
  const steps = replaySteps(path)
  const finalStep = finalStepOf(path)
  steps.push(finalStep === undefined ? initStepOf(path.state) : finalStep)
  return steps
}

// TODO: rewrite parts of the algorithm leading to this to make this function obsolete
export function alterPath<T extends ErasedStatePath>(path: T): T
export function alterPath<T extends ErasedStatePath>(path: T): ErasedStatePath {
  return {
    ...path,
    steps: appendedSteps(path),
  }
}
