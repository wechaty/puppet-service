#!/usr/bin/env ts-node

import {
  test,
}         from 'tstest'

import https from 'https'

import {
  GET_WECHATY_PUPPET_SERVICE_SSL_ROOT_CERT,
  GET_WECHATY_PUPPET_SERVICE_SSL_SERVER_CERT,
  GET_WECHATY_PUPPET_SERVICE_SSL_SERVER_KEY,
}                                               from './ca'
import { AddressInfo } from 'ws'

test('CA smoke testing', async t => {

  const ca   = GET_WECHATY_PUPPET_SERVICE_SSL_ROOT_CERT()
  const cert = GET_WECHATY_PUPPET_SERVICE_SSL_SERVER_CERT()
  const key  = GET_WECHATY_PUPPET_SERVICE_SSL_SERVER_KEY()

  const server = https.createServer({
    cert,
    key,
  })

  const ALIVE = 'Alive!\n'
  const SNI = 'wechaty-puppet-service'

  server.on('request', (_req, res) => {
    res.writeHead(200)
    res.end(ALIVE)
  })

  server.listen()
  const port = (server.address() as AddressInfo).port

  const reply = await new Promise((resolve, reject) => {
    https.request({
      ca,
      hostname: '127.0.0.1',
      method: 'GET',
      path: '/',
      port,
      servername: SNI,
    }, res => {
      res.on('data', chunk => resolve(chunk.toString()))
      res.on('error', reject)
    }).end()
  })
  server.close()

  t.equal(reply, ALIVE, 'should get https server reply')
})
