#!/usr/bin/env ts-node

import {
  test,
  sinon,
} from 'tstest'

import {
  PuppetOptions,
} from 'wechaty-puppet'
import {
  PuppetMock,
} from 'wechaty-puppet-mock'

import {
  PuppetService,
  PuppetServer,
  PuppetServerOptions,
} from '../src/mod'

test('Close eventStream when gRPC breaks', async (t) => {
  const TOKEN = 'test_token'
  const ENDPOINT = '0.0.0.0:8788'

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
  puppetService.mockGrpcBreak = async function() {
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
