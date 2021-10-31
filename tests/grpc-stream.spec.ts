#!/usr/bin/env ts-node

/**
   * @hcfw007, https://wechaty.js.org/contributors/wang-nan/
   * related issue: attempt to reconnect gRPC after disconnection
   * Scenario: the watchdog tries to restart the service but failed due to the existence of eventstream
   * Caused by the grpcClient set to undefined (still working on why this happens) while eventstream still working
   * issue: #172, https://github.com/wechaty/puppet-service/issues/172
   */

import {
  test,
  sinon,
}                             from 'tstest'
import type {
  PuppetOptions,
}                             from 'wechaty-puppet'
import {
  PuppetMock,
}                             from 'wechaty-puppet-mock'
import getPort                from 'get-port'

import {
  PuppetService,
  PuppetServer,
  PuppetServerOptions,
}                             from '../src/mod.js'

test('Close eventStream when gRPC breaks', async (t) => {
  const TOKEN       = 'test_token'
  const PORT        = await getPort()
  const ENDPOINT    = `0.0.0.0:${PORT}`

  const puppet = new PuppetMock()
  const spyStart = sinon.spy(puppet, 'start')
  /**
   * Puppet Server
   */
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

  const puppetService = (new PuppetService(puppetOptions)) as any
  await puppetService.start()
  t.ok(spyStart.called, 'should called the puppet server start() function')

  // mock grpcClient break
  puppetService.mockGrpcBreak = async function () {
    await this.stopGrpcClient()
  }

  await puppetService.mockGrpcBreak()
  await puppetService.stop()

  // get eventStream status
  puppetService.getEventStream = function () {
    return this.eventStream
  }
  if (puppetService.getEventStream()) {
    t.fail('event stream should be closed')
  } else {
    t.pass('event stream is closed')
  }

  await puppetServer.stop()
})
