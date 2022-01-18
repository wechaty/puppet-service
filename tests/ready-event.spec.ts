#!/usr/bin/env -S node --no-warnings --loader ts-node/esm

import { test } from 'tstest'
import type {
  PuppetOptions,
} from 'wechaty-puppet'
import PuppetMock from 'wechaty-puppet-mock'
import getPort from 'get-port'

import PuppetService, {
  PuppetServer,
  PuppetServerOptions,
} from '../src/mod.js'
import { log } from 'brolog'

const NIL_UUID_V4 = '00000000-0000-0000-0000-000000000000'
const TIME_WAITING_FOR_READY = 10 * 1000

const PRE = 'ReadyEventTest'

test('ready event test', async t => {
  const PORT = await getPort()
  const TOKEN = `insecure_${NIL_UUID_V4}`
  const ENDPOINT = `0.0.0.0:${PORT}`

  /**
   * Puppet Server
   */
  const puppet = new PuppetMock()

  // set ready to true before service starts
  puppet.readyIndicator.value(true)
  const serverOptions = {
    endpoint: ENDPOINT,
    puppet: puppet,
    token: TOKEN,
  } as PuppetServerOptions

  const puppetServer = new PuppetServer(serverOptions)

  await puppetServer.start()

  /**
   * Puppet Service Client
   */
  const puppetOptions = {
    endpoint: ENDPOINT,
    token: TOKEN,
  } as PuppetOptions

  // check if ready event is emited on this ready-ed puppet
  const puppetService = new PuppetService(puppetOptions)

  let ready = false
  let testResolver: Function
  let testRejector: Function
  const testPromise = new Promise((resolve, reject) => {
    testResolver = resolve
    testResolver()
    testRejector = reject
  })

  const timeout = setTimeout(() => {
    if (!ready) {
      t.fail('receive the ready event timeout')
      testRejector()
    }
  }, TIME_WAITING_FOR_READY)

  puppetService.on('ready', () => {
    log.info(PRE, 'got the ready event')
    ready = true
    t.pass('should receive the ready event')
    clearTimeout(timeout)
  })

  await puppetService.start()

  await testPromise

  await puppetService.stop()
  await puppetServer.stop()
})
