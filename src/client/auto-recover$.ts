import {
  Puppet,
  log,
}                   from 'wechaty-puppet'

import type {
  FromEvent,
}                               from 'typed-emitter/rxjs'
import {
  fromEvent as rxFromEvent,
  interval,
  merge,
  ignoreElements,
}                               from 'rxjs'
import {
  debounce,
  filter,
  switchMap,
  takeUntil,
  tap,
  mapTo,
}             from 'rxjs/operators'

const fromEvent: FromEvent = rxFromEvent

/**
 * Filters
 */
const isStable = (status: true | 'pending') => status === true

/**
 * Actions
 */
const reset = (puppet: Puppet) => (_: number) => {
  log.verbose('auto-recover$', 'reset()')
  puppet.wrapAsync(puppet.reset())
}

const ding  = (puppet: Puppet) => (n: number) => {
  log.verbose('auto-recover$', 'ding()')
  puppet.ding(`recover$() CPR #${n}`)
}

/**
 * Observables
 */
const stateActive$   = (puppet: Puppet) => fromEvent<true | 'pending'>(puppet.state as any, 'active').pipe(filter(isStable))
const stateInactive$ = (puppet: Puppet) => fromEvent<true | 'pending'>(puppet.state as any, 'inactive')
const heartbeat$     = (puppet: Puppet) => fromEvent(puppet, 'heartbeat')

/**
 * Streams
 */

/**
 * The GRPC keepalive timeout is 20 seconds
 * So we use 15 seconds to save the GRPC keepalive cost
 *
 *  https://github.com/grpc/grpc/blob/master/doc/keepalive.md
 *    GRPC_ARG_KEEPALIVE_TIMEOUT_MS 20000 (20 seconds)  20000 (20 seconds)
 */
const TIMEOUT_SOFT = 15 * 1000
const TIMEOUT_HARD = Math.floor(4.5 * TIMEOUT_SOFT)

// Emit when an active puppet have no heartbeat after a timeout period
const noHeartbeatSoft = (timeout: number) => (puppet: Puppet) => stateActive$(puppet).pipe(
  switchMap(() => heartbeat$(puppet).pipe(
    debounce(() => interval(timeout)),
    switchMap(() => interval(Math.floor(timeout / 2))),
    takeUntil(stateInactive$(puppet)),
  )),
)

// Trigger an AED (Automated External Defibrillator)
const noHeartbeatHard = (timeout: number) => (puppet: Puppet) => stateActive$(puppet).pipe(
  switchMap(() => heartbeat$(puppet).pipe(
    debounce(() => interval(timeout)),
    switchMap(() => interval(timeout * 2)),
    takeUntil(stateInactive$(puppet)),
  )),
)

/**
 * Main stream
 */
const autoRecover$ = (puppet: Puppet) => merge(
  noHeartbeatSoft(TIMEOUT_SOFT)(puppet).pipe(
    tap(ding(puppet)),
    mapTo('auto-recover$ noHeartbeatSoft() ding'),
  ),
  noHeartbeatHard(TIMEOUT_HARD)(puppet).pipe(
    tap(reset(puppet)),
    mapTo('auto-recover$ noHeartbeatSoft() reset'),
  ),
)

export {
  autoRecover$,
  isStable,
  noHeartbeatHard,
  noHeartbeatSoft,
}
