import util from 'util'
import EventEmitter from 'events'
import crypto from 'crypto'

import {
  grpc,
  PuppetClient,
  EventRequest,
  StartRequest,
  StopRequest,
  EventResponse,
}                   from 'wechaty-grpc'

import {
  GRPC_OPTIONS,
  log,
  envVars,
}                   from '../config'

import { callCredToken }  from '../auth/mod'
import { GrpcStatus }     from '../auth/grpc-js'
import {
  TLS_CA_CERT,
  TLS_INSECURE_SERVER_CERT_COMMON_NAME,
}                                         from '../auth/ca'

import { PuppetServiceOptions } from './puppet-service'

class GrpcClient extends EventEmitter {

  client?      : PuppetClient
  eventStream? : grpc.ClientReadableStream<EventResponse>

  /**
   * gRPC settings
   */
  endpoint    : string
  noTlsInsecure : boolean
  serverName  : string
  caCert      : Buffer
  token       : string

  constructor (private options: PuppetServiceOptions) {
    super()
    log.verbose('GrpcClient', 'constructor(%s)', JSON.stringify(options))

    this.caCert = Buffer.from(
      envVars.WECHATY_PUPPET_SERVICE_TLS_CA_CERT(this.options.tls?.caCert) || TLS_CA_CERT
    )
    log.verbose('GrpcClient', 'constructor() tlsRootCert(hash): "%s"',
      crypto.createHash('sha256')
        .update(this.caCert)
        .digest('hex'),
    )

    /**
     * Token will be used in the gRPC resolver (in endpoint)
     */
    this.token = envVars.WECHATY_PUPPET_SERVICE_TOKEN(this.options.token)
    log.verbose('GrpcClient', 'constructor() token: "%s"', this.token)

    this.endpoint = envVars.WECHATY_PUPPET_SERVICE_ENDPOINT(this.options.endpoint)
      || [
        'wechaty://',
        envVars.WECHATY_PUPPET_SERVICE_AUTHORITY(this.options.authority),
        '/',
        this.token,
      ].join('')
    log.verbose('GrpcClient', 'constructor() endpoint: "%s"', this.endpoint)

    /**
     *
     */
    this.noTlsInsecure = envVars.WECHATY_PUPPET_SERVICE_NO_TLS_INSECURE_CLIENT(this.options.tls?.disable)
    log.verbose('GrpcClient', 'constructor() noTlsInsecure: "%s"', this.noTlsInsecure)

    /**
     * for Node.js TLS SNI
     *  https://en.wikipedia.org/wiki/Server_Name_Indication
     */
    this.serverName = envVars.WECHATY_PUPPET_SERVICE_TLS_SERVER_NAME(this.options.tls?.serverName)
      || TLS_INSECURE_SERVER_CERT_COMMON_NAME
    log.verbose('GrpcClient', 'constructor() servername: "%s"', this.serverName)
  }

  async start (): Promise<void> {
    log.verbose('GrpcClient', 'start()')

    /**
     * 1. Init grpc client
     */
    await this.init()
    /**
     * 2. Connect to stream
     */
    await this.startStream()
    /**
     * 3. Start the puppet
     */
    await util.promisify(
      this.client!.start
        .bind(this.client)
    )(new StartRequest())
  }

  async stop (): Promise<void> {
    log.verbose('GrpcClient', 'stop()')

    /**
     * 1. Disconnect from stream
     */
    await this.stopStream()

    /**
     * 2. Stop the puppet
     */
    await util.promisify(
      this.client!.stop.bind(this.client)
    )(new StopRequest())
    /**
     * 3. Destroy grpc client
     */
    await this.destroy()
  }

  protected async init (): Promise<void> {
    log.verbose('GrpcClient', 'init()')

    const callCred    = callCredToken(this.token)
    const channelCred = grpc.credentials.createSsl(this.caCert)
    const combCreds   = grpc.credentials.combineChannelCredentials(channelCred, callCred)

    /**
     * Huan(202108): for maximum compatible with the non-tls community servers/clients,
     *  we introduced the WECHATY_PUPPET_SERVICE_NO_TLS_INSECURE_{SERVER,CLIENT} environment variables.
     *  if it has been set, then we will run under HTTP instead of HTTPS
     */
    let credential
    if (this.noTlsInsecure) {
      log.warn('PuppetServer', 'start() noTlsInsecure should not be set in production!')
      credential = grpc.credentials.createInsecure()
    } else {
      credential = combCreds
    }

    const clientOptions: grpc.ChannelOptions = {
      ...GRPC_OPTIONS,
      /**
       * Huan(202108): this is a workaround for compatiblity with the non-tls community servers/clients.
       *  Will be removed after Dec 21, 2022.
       *
       * See: https://github.com/wechaty/wechaty-puppet-service/pull/78
       */
      'grpc.default_authority'        : this.token,
      'grpc.ssl_target_name_override' : this.serverName,
    }

    if (this.client) {
      log.error('GrpcClient', 'init() this.client exists? Old client has been dropped.')
      this.client = undefined
    }

    this.client = new PuppetClient(
      this.endpoint,
      credential,
      clientOptions,
    )
  }

  protected destroy (): void {
    log.verbose('GrpcClient', 'destroy()')

    if (!this.client) {
      log.error('GrpcClient', 'destroy() this.client not exist')
      return
    }
    /**
      * Huan(202108): we should set `this.client` to `undefined` at the current event loop
      *   to prevent the future usage of the old client.
      */
    const client = this.client
    this.client = undefined

    try {
      client.close()
    } catch (e) {
      log.error('GrpcClient', 'destroy() grpcClient.close() rejection: %s\n%s', e && e.message, e.stack)
    }
  }

  protected async startStream (): Promise<void> {
    log.verbose('GrpcClient', 'startStream()')

    if (!this.client) {
      throw new Error('this.client not exist')
    }

    if (this.eventStream) {
      log.verbose('GrpcClient', 'startStream() this.eventStream exists, dropped.')
      this.eventStream = undefined
    }

    const eventStream = this.client.event(new EventRequest())

    /**
     * Store the event data from the stream when we test connection,
     *  and re-emit the event data when we have finished testing the connection
     */
    let peekedData: undefined | EventResponse

    /**
     * Huan(202108): future must be placed before other listenser registration
     *  because the on('data') will start drain the stream
     */
    const future = new Promise<void>((resolve, reject) => eventStream
      /**
       * Huan(202108): we need a `heartbeat` event to confirm the connection is alive
       *  for our wechaty-puppet-service server code, when the gRPC event stream is opened,
       *  it will emit a `heartbeat` event as early as possible.
       *
       * However, the `heartbeat` event is not guaranteed to be emitted,
       *  if the puppet service provider is coming from the community, like:
       *    - paimon
       *
       * So we also need a timeout for compatible with those providers
       *  in case of they are not following this special protocol.
       */
      .once('data', (resp: EventResponse) => {
        peekedData = resp
        resolve()
      })
      /**
       * Any of the following events will be emitted means that there's a problem.
       */
      .once('cancel', reject)
      .once('end',    reject)
      .once('error',  reject)
      /**
       * The `status` event is import when we connect a gRPC stream.
       *
       * Huan(202108): according to the unit tests (tests/grpc-client.spec.ts)
       *  1. If client TLS is not ok (client no-tls but server TLS is required)
       *    then status will be:
       *      { code: 14, details: 'Connection dropped' }
       *  2. If client TLS is ok but the client token is invalid,
       *    then status will be:
       *      { code: 16, details: 'Invalid Wechaty TOKEN "0.XXX"' }
       */
      .once('status',   status => {
        // console.info('once(status)', status)
        status.code === GrpcStatus.OK
          ? resolve()
          : reject(new Error('once(status)'))
      })
      /**
       * Huan(202108): `metadata` event will be fired
       *  when the TLS connection is OK
       *    even if the token is invalid
       *
       * Conclusion: we MUST NOT listen on `metadata` for `resolve`.
       */
      // .once('metadata', (...args) => console.info('once(metadata)', ...args))

    )

    /**
     * Huan(202108): the `heartbeat` event is not guaranteed to be emitted
     *  if a puppet service provider is coming from the community, and it does not follow the protocol.
     * So we need a timeout for compatible with those providers
     */
    const TIMEOUT = 5 * 1000 // 5 seconds
    const timeout = new Promise<void>(resolve => setTimeout(resolve, TIMEOUT).unref())

    // console.info('here')
    await Promise.race([
      future,
      timeout,
    ])
    // console.info('there')

    /**
     * Bridge the events
     * Huan(202108): adding the below event listeners
     *  must be after the `await future` above,
     *  so that if there's any `error` event,
     *  it will be triggered already.
     */
    eventStream
      .on('cancel',   (...args) => this.emit('cancel',    ...args))
      .on('data',     (...args) => this.emit('data',      ...args))
      .on('end',      (...args) => this.emit('end',       ...args))
      .on('error',    (...args) => this.emit('error',     ...args))
      .on('metadata', (...args) => this.emit('metadata',  ...args))
      .on('status',   (...args) => this.emit('status',    ...args))

    this.eventStream = eventStream

    /**
     * Re-emit the peeked data if there's any
     */
    if (peekedData) {
      this.emit('data', peekedData)
      peekedData = undefined
    }
  }

  protected stopStream (): void {
    log.verbose('GrpcClient', 'stopStream()')

    if (!this.eventStream) {
      log.verbose('GrpcClient', 'no eventStream when stop, skip destroy.')
      return
    }
    /**
      * Huan(202108): we should set `this.eventStream` to `undefined` at the current event loop
      *   to prevent the future usage of the old eventStream.
      */
    const eventStream = this.eventStream
    this.eventStream = undefined

    /**
     * Huan(202003):
     *  destroy() will be enough to terminate a stream call.
     *  cancel() is not needed.
     */
    // this.eventStream.cancel()

    eventStream.destroy()
  }

}

export {
  GrpcClient,
}
