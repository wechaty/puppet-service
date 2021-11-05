import util from 'util'

import * as PUPPET    from 'wechaty-puppet'

import type {
  FileBoxInterface,
  FileBox,
}                     from 'file-box'

import {
  StringValue,
  puppet as grpcPuppet,
}                           from 'wechaty-grpc'

import type { Subscription } from 'rxjs'

/**
 * Deprecated. Will be removed after Dec 31, 2022
 */
import {
  packConversationIdFileBoxToPb,
  unpackFileBoxFromPb,
}                                     from '../deprecated/mod.js'
import { serializeFileBox }           from '../deprecated/serialize-file-box.js'

import { millisecondsFromTimestamp }  from '../pure-functions/timestamp.js'

import {
  uuidifyFileBoxGrpc,
  normalizeFileBoxUuid,
}                       from '../file-box-helper/mod.js'

import {
  envVars,
  log,
  VERSION,
}                       from '../config.js'
import {
  EventTypeRev,
}                       from '../event-type-rev.js'
import { packageJson }  from '../package-json.js'

import { recover$ }     from './recover$.js'
import { GrpcClient }   from './grpc-client.js'
import { PayloadStore } from './payload-store.js'

export type PuppetServiceOptions = PUPPET.PuppetOptions & {
  authority?  : string
  tls?: {
    caCert?     : string
    serverName? : string
    /**
     * Huan(202108): only for compatible with old clients/servers
     *  for disabling TLS
     */
    disable? : boolean
  }
}

export class PuppetService extends PUPPET.Puppet {

  static override readonly VERSION = VERSION

  protected recoverSubscription?: Subscription
  protected payloadStore: PayloadStore

  protected _grpc?  : GrpcClient
  get grpc ()     : GrpcClient {
    if (!this._grpc) {
      throw new Error('no grpc client')
    }
    return this._grpc
  }

  /**
   * UUIDify:
   *  We need to clone a FileBox
   *  to set uuid loader/saver with this grpc client
   */
  protected FileBoxUuid: typeof FileBox

  constructor (
    public override options: PuppetServiceOptions = {},
  ) {
    super(options)
    this.payloadStore = new PayloadStore({
      token: envVars.WECHATY_PUPPET_SERVICE_TOKEN(this.options.token),
    })

    this.hookPayloadStore()

    this.FileBoxUuid = uuidifyFileBoxGrpc(() => this.grpc.client)
  }

  protected async serializeFileBox (fileBox: FileBoxInterface): Promise<string> {
    /**
     * 1. if the fileBox is one of type `Url`, `QRCode`, `Uuid`, etc,
     *  then it can be serialized by `fileBox.toString()`
     * 2. if the fileBox is one of type `Stream`, `Buffer`, `File`, etc,
     *  then it need to be convert to type `Uuid`
     *  before serialized by `fileBox.toString()`
     */
    const normalizedFileBox = await normalizeFileBoxUuid(this.FileBoxUuid)(fileBox)
    return JSON.stringify(normalizedFileBox)
  }

  override name () {
    return packageJson.name || 'wechaty-puppet-service'
  }

  override version () {
    return packageJson.version || '0.0.0'
  }

  override async onStart (): Promise<void> {
    log.verbose('PuppetService', 'onStart()')

    if (this._grpc) {
      log.warn('PuppetService', 'onStart() found this.grpc is already existed. dropped.')
      this._grpc = undefined
    }

    const grpc = new GrpcClient(this.options)
    /**
     * Huan(202108): when we started the event stream,
     *  the `this.grpc` need to be available for all listeners.
     */
    this._grpc = grpc

    this.bridgeGrpcEventStream(grpc)
    await grpc.start()

    this.recoverSubscription = recover$(this).subscribe({
      complete : () => log.verbose('PuppetService', 'onStart() recover$().subscribe() complete()'),
      error    : e  => log.error('PuppetService', 'onStart() recover$().subscribe() error(%s)', e),
      next     : x  => log.verbose('PuppetService', 'onStart() recover$().subscribe() next(%s)', JSON.stringify(x)),
    })
  }

  override async onStop (): Promise<void> {
    log.verbose('PuppetService', 'onStop()')

    if (this.recoverSubscription) {
      const recoverSubscription = this.recoverSubscription
      this.recoverSubscription = undefined
      recoverSubscription.unsubscribe()
    }

    if (this._grpc) {
      const grpc = this._grpc
      this._grpc = undefined
      await grpc.stop()
    }
  }

  protected hookPayloadStore (): void {
    log.verbose('PuppetService', 'hookPayloadStore()')

    this.on('login',  async ({ contactId }) => {
      try {
        log.verbose('PuppetService', 'hookPayloadStore() this.on(login) contactId: "%s"', contactId)
        await this.payloadStore.start(contactId)
      } catch (e) {
        log.verbose('PuppetService', 'hookPayloadStore() this.on(login) rejection "%s"', (e as Error).message)
      }
    })

    this.on('logout', async ({ contactId }) => {
      log.verbose('PuppetService', 'hookPayloadStore() this.on(logout) contactId: "%s"', contactId)
      try {
        await this.payloadStore.stop()
      } catch (e) {
        log.verbose('PuppetService', 'hookPayloadStore() this.on(logout) rejection "%s"', (e as Error).message)
      }
    })
  }

  protected bridgeGrpcEventStream (client: GrpcClient): void {
    log.verbose('PuppetService', 'bridgeGrpcEventStream(client)')

    client
      .on('data', this.onGrpcStreamEvent.bind(this))
      .on('end', () => {
        log.verbose('PuppetService', 'bridgeGrpcEventStream() eventStream.on(end)')
      })
      .on('error', (e: unknown) => {
        this.emit('error', e)
        // https://github.com/wechaty/wechaty-puppet-service/issues/16
        // log.verbose('PuppetService', 'bridgeGrpcEventStream() eventStream.on(error) %s', e)
        // const reason = 'bridgeGrpcEventStream() eventStream.on(error) ' + e
        /**
         * Huan(202110): simple reset puppet when grpc client has error? (or not?)
         */
        // this.wrapAsync(this.reset())
        // /**
        //  * The `Puppet` class have a throttleQueue for receiving the `reset` events
        //  *  and it's the `Puppet` class's duty for call the `puppet.reset()` to reset the puppet.
        //  */
        // if (this.state.on()) {
        //   this.emit('reset', { data: reason })
        // }
      })
      .on('cancel', (...args: any[]) => {
        log.verbose('PuppetService', 'bridgeGrpcEventStream() eventStream.on(cancel), %s', JSON.stringify(args))
      })
  }

  private onGrpcStreamEvent (event: grpcPuppet.EventResponse): void {
    const type    = event.getType()
    const payload = event.getPayload()

    log.verbose('PuppetService',
      'onGrpcStreamEvent({type:%s(%s), payload(len:%s)})',
      EventTypeRev[type],
      type,
      payload.length,
    )
    log.silly('PuppetService',
      'onGrpcStreamEvent({type:%s(%s), payload:"%s"})',
      EventTypeRev[type],
      type,
      payload,
    )

    if (type !== grpcPuppet.EventType.EVENT_TYPE_HEARTBEAT) {
      this.emit('heartbeat', {
        data: `onGrpcStreamEvent(${EventTypeRev[type]})`,
      })
    }

    switch (type) {
      case grpcPuppet.EventType.EVENT_TYPE_DONG:
        this.emit('dong', JSON.parse(payload) as PUPPET.payload.EventDong)
        break
      case grpcPuppet.EventType.EVENT_TYPE_ERROR:
        this.emit('error', JSON.parse(payload) as PUPPET.payload.EventError)
        break
      case grpcPuppet.EventType.EVENT_TYPE_HEARTBEAT:
        this.emit('heartbeat', JSON.parse(payload) as PUPPET.payload.EventHeartbeat)
        break
      case grpcPuppet.EventType.EVENT_TYPE_FRIENDSHIP:
        this.emit('friendship', JSON.parse(payload) as PUPPET.payload.EventFriendship)
        break
      case grpcPuppet.EventType.EVENT_TYPE_LOGIN:
        {
          const loginPayload = JSON.parse(payload) as PUPPET.payload.EventLogin
          ;(
            async () => this.login(loginPayload.contactId)
          )().catch(e =>
            log.error('PuppetService', 'onGrpcStreamEvent() this.login() rejection %s',
              (e as Error).message,
            ),
          )
        }
        break
      case grpcPuppet.EventType.EVENT_TYPE_LOGOUT:
        {
          const logoutPayload = JSON.parse(payload) as PUPPET.payload.EventLogout
          ;(
            async () => this.logout(logoutPayload.data)
          )().catch(e =>
            log.error('PuppetService', 'onGrpcStreamEvent() this.logout() rejection %s',
              (e as Error).message,
            ),
          )
        }
        break
      case grpcPuppet.EventType.EVENT_TYPE_DIRTY:
        this.emit('dirty', JSON.parse(payload) as PUPPET.payload.EventDirty)
        break
      case grpcPuppet.EventType.EVENT_TYPE_MESSAGE:
        this.emit('message', JSON.parse(payload) as PUPPET.payload.EventMessage)
        break
      case grpcPuppet.EventType.EVENT_TYPE_READY:
        this.emit('ready', JSON.parse(payload) as PUPPET.payload.EventReady)
        break
      case grpcPuppet.EventType.EVENT_TYPE_ROOM_INVITE:
        this.emit('room-invite', JSON.parse(payload) as PUPPET.payload.EventRoomInvite)
        break
      case grpcPuppet.EventType.EVENT_TYPE_ROOM_JOIN:
        this.emit('room-join', JSON.parse(payload) as PUPPET.payload.EventRoomJoin)
        break
      case grpcPuppet.EventType.EVENT_TYPE_ROOM_LEAVE:
        this.emit('room-leave', JSON.parse(payload) as PUPPET.payload.EventRoomLeave)
        break
      case grpcPuppet.EventType.EVENT_TYPE_ROOM_TOPIC:
        this.emit('room-topic', JSON.parse(payload) as PUPPET.payload.EventRoomTopic)
        break
      case grpcPuppet.EventType.EVENT_TYPE_SCAN:
        this.emit('scan', JSON.parse(payload) as PUPPET.payload.EventScan)
        break
      case grpcPuppet.EventType.EVENT_TYPE_RESET:
        log.warn('PuppetService', 'onGrpcStreamEvent() got an EventType.EVENT_TYPE_RESET ?')
        // the `reset` event should be dealed not send out
        break

      case grpcPuppet.EventType.EVENT_TYPE_UNSPECIFIED:
        log.error('PuppetService', 'onGrpcStreamEvent() got an EventType.EVENT_TYPE_UNSPECIFIED ?')
        break

      default:
        // Huan(202003): in default, the `type` type should be `never`, please check.
        throw new Error('eventType ' + type + ' unsupported! (code should not reach here)')
    }
  }

  override async logout (reason?: string): Promise<void> {
    log.verbose('PuppetService', 'logout(%s)', reason ? `"${reason}"` : '')

    super.logout(reason)

    try {
      await util.promisify(
        this.grpc.client.logout
          .bind(this.grpc.client),
      )(new grpcPuppet.LogoutRequest())

    } catch (e) {
      log.silly('PuppetService', 'logout() no grpc client')
    }
  }

  override ding (data: string): void {
    log.silly('PuppetService', 'ding(%s)', data)

    const request = new grpcPuppet.DingRequest()
    request.setData(data || '')

    this.grpc.client.ding(
      request,
      (error, _response) => {
        if (error) {
          log.error('PuppetService', 'ding() rejection: %s', error)
        }
      },
    )
  }

/**
 *
 * Huan(202111) Issue #158 - Refactoring the 'dirty' event, dirtyPayload(),
 *  and XXXPayloadDirty() methods logic & spec
 *
 *    @see https://github.com/wechaty/puppet/issues/158
 *
 */
 override async dirtyPayload (type: PUPPET.type.Payload, id: string) {
    log.verbose('PuppetService', 'dirtyPayload(%s, %s)', type, id)

    await super.dirtyPayload(type, id)

    switch (type) {
      case PUPPET.type.Payload.Contact:
        await this.payloadStore.contact?.delete(id)
        break
      case PUPPET.type.Payload.Friendship:
        // TODO
        break
      case PUPPET.type.Payload.Message:
        // await this.payloadStore.message?.del(id)
        // TODO
        break
      case PUPPET.type.Payload.Room:
        await this.payloadStore.room?.delete(id)
        break
      case PUPPET.type.Payload.RoomMember:
        await this.payloadStore.roomMember?.delete(id)
        break
      default:
        log.error('PuppetService', 'dirtyPayload(%s) unknown type', type)
        break
    }

    const request = new grpcPuppet.DirtyPayloadRequest()
    request.setId(id)
    request.setType(type)
    try {
      await util.promisify(
        this.grpc.client.dirtyPayload
          .bind(this.grpc.client),
      )(request)

    } catch (e) {
      log.error('PuppetService', 'dirtyPayload() rejection: %s', e && (e as Error).message)
      throw e
    }
  }

  /**
   *
   * Contact
   *
   */
  override contactAlias (contactId: string)                      : Promise<string>
  override contactAlias (contactId: string, alias: string | null): Promise<void>

  override async contactAlias (contactId: string, alias?: string | null): Promise<void | string> {
    log.verbose('PuppetService', 'contactAlias(%s, %s)', contactId, alias)

    /**
     * Get alias
     */
    if (typeof alias === 'undefined') {
      const request = new grpcPuppet.ContactAliasRequest()
      request.setId(contactId)

      const response = await util.promisify(
        this.grpc.client.contactAlias
          .bind(this.grpc.client),
      )(request)

      const result = response.getAlias()
      if (result) {
        return result
      }

      {
        // DEPRECATED, will be removed after Dec 31, 2022
        const aliasWrapper = response.getAliasStringValueDeprecated()

        if (!aliasWrapper) {
          throw new Error('can not get aliasWrapper')
        }

        return aliasWrapper.getValue()
      }
    }

    /**
     * Set alias
     */
    const request = new grpcPuppet.ContactAliasRequest()
    request.setId(contactId)
    request.setAlias(alias || '')   // null -> '', in server, we treat '' as null

    {
      // DEPRECATED, will be removed after Dec 31, 2022
      const aliasWrapper = new StringValue()
      aliasWrapper.setValue(alias || '')  // null -> '', in server, we treat '' as null
      request.setAliasStringValueDeprecated(aliasWrapper)
    }

    await util.promisify(
      this.grpc.client.contactAlias
        .bind(this.grpc.client),
    )(request)
  }

  override async contactPhone (contactId: string, phoneList: string[]): Promise<void> {
    log.verbose('PuppetService', 'contactPhone(%s, %s)', contactId, phoneList)

    const request = new grpcPuppet.ContactPhoneRequest()
    request.setContactId(contactId)
    request.setPhonesList(phoneList)

    await util.promisify(
      this.grpc.client.contactPhone
        .bind(this.grpc.client),
    )(request)
  }

  override async contactCorporationRemark (contactId: string, corporationRemark: string | null) {
    log.verbose('PuppetService', 'contactCorporationRemark(%s, %s)', contactId, corporationRemark)

    const request = new grpcPuppet.ContactCorporationRemarkRequest()
    request.setContactId(contactId)
    if (corporationRemark) {
      request.setCorporationRemark(corporationRemark)
    }

    {
      // DEPRECATED, will be removed after Dec 31, 2022
      const corporationRemarkWrapper = new StringValue()
      if (corporationRemark) {
        corporationRemarkWrapper.setValue(corporationRemark)
        request.setCorporationRemarkStringValueDeprecated(corporationRemarkWrapper)
      }
    }

    await util.promisify(
      this.grpc.client.contactCorporationRemark
        .bind(this.grpc.client),
    )(request)
  }

  override async contactDescription (contactId: string, description: string | null) {
    log.verbose('PuppetService', 'contactDescription(%s, %s)', contactId, description)

    const request = new grpcPuppet.ContactDescriptionRequest()
    request.setContactId(contactId)
    if (description) {
      request.setDescription(description)
    }

    {
      // DEPRECATED, will be removed after Dec 31, 2022
      const descriptionWrapper = new StringValue()
      if (description) {
        descriptionWrapper.setValue(description)
        request.setDescriptionStringValueDeprecated(descriptionWrapper)
      }
    }

    await util.promisify(
      this.grpc.client.contactDescription
        .bind(this.grpc.client),
    )(request)
  }

  override async contactList (): Promise<string[]> {
    log.verbose('PuppetService', 'contactList()')

    const response = await util.promisify(
      this.grpc.client.contactList
        .bind(this.grpc.client),
    )(new grpcPuppet.ContactListRequest())

    return response.getIdsList()
  }

  override async contactAvatar (contactId: string)                          : Promise<FileBoxInterface>
  override async contactAvatar (contactId: string, file: FileBoxInterface)  : Promise<void>

  override async contactAvatar (contactId: string, fileBox?: FileBoxInterface): Promise<void | FileBoxInterface> {
    log.verbose('PuppetService', 'contactAvatar(%s)', contactId)

    /**
     * 1. set
     */
    if (fileBox) {
      const request = new grpcPuppet.ContactAvatarRequest()
      request.setId(contactId)

      const serializedFileBox = await this.serializeFileBox(fileBox)
      request.setFileBox(serializedFileBox)

      {
        // DEPRECATED, will be removed after Dec 31, 2022
        const fileboxWrapper = new StringValue()
        fileboxWrapper.setValue(await serializeFileBox(fileBox))
        request.setFileboxStringValueDeprecated(fileboxWrapper)
      }

      await util.promisify(
        this.grpc.client.contactAvatar
          .bind(this.grpc.client),
      )(request)

      return
    }

    /**
     * 2. get
     */
    const request = new grpcPuppet.ContactAvatarRequest()
    request.setId(contactId)

    const response = await util.promisify(
      this.grpc.client.contactAvatar
        .bind(this.grpc.client),
    )(request)

    let jsonText: string
    jsonText = response.getFileBox()

    {
      // DEPRECATED, will be removed after Dec 31, 2022
      const deprecated = true
      void deprecated

      if (!jsonText) {
        const textWrapper = response.getFileboxStringValueDeprecated()
        if (!textWrapper) {
          throw new Error('can not get textWrapper')
        }
        jsonText = textWrapper.getValue()
      }
    }

    return this.FileBoxUuid.fromJSON(jsonText)
  }

  override async contactRawPayload (id: string): Promise<PUPPET.payload.Contact> {
    log.verbose('PuppetService', 'contactRawPayload(%s)', id)

    const cachedPayload = await this.payloadStore.contact?.get(id)
    if (cachedPayload) {
      log.silly('PuppetService', 'contactRawPayload(%s) cache HIT', id)
      return cachedPayload
    }

    const request = new grpcPuppet.ContactPayloadRequest()
    request.setId(id)

    const response = await util.promisify(
      this.grpc.client.contactPayload
        .bind(this.grpc.client),
    )(request)

    const payload: PUPPET.payload.Contact = {
      address     : response.getAddress(),
      alias       : response.getAlias(),
      avatar      : response.getAvatar(),
      city        : response.getCity(),
      corporation : response.getCorporation(),
      coworker    : response.getCoworker(),
      description : response.getDescription(),
      friend      : response.getFriend(),
      gender      : response.getGender() as number,
      id          : response.getId(),
      name        : response.getName(),
      phone       : response.getPhonesList(),
      province    : response.getProvince(),
      signature   : response.getSignature(),
      star        : response.getStar(),
      title       : response.getTitle(),
      type        : response.getType() as number,
      weixin      : response.getWeixin(),
    }

    await this.payloadStore.contact?.set(id, payload)
    log.silly('PuppetService', 'contactRawPayload(%s) cache SET', id)

    return payload
  }

  override async contactRawPayloadParser (payload: PUPPET.payload.Contact): Promise<PUPPET.payload.Contact> {
    // log.silly('PuppetService', 'contactRawPayloadParser({id:%s})', payload.id)
    // passthrough
    return payload
  }

  override async contactSelfName (name: string): Promise<void> {
    log.verbose('PuppetService', 'contactSelfName(%s)', name)

    const request = new grpcPuppet.ContactSelfNameRequest()
    request.setName(name)

    await util.promisify(
      this.grpc.client.contactSelfName
        .bind(this.grpc.client),
    )(request)
  }

  override async contactSelfQRCode (): Promise<string> {
    log.verbose('PuppetService', 'contactSelfQRCode()')

    const response = await util.promisify(
      this.grpc.client.contactSelfQRCode
        .bind(this.grpc.client),
    )(new grpcPuppet.ContactSelfQRCodeRequest())

    return response.getQrcode()
  }

  override async contactSelfSignature (signature: string): Promise<void> {
    log.verbose('PuppetService', 'contactSelfSignature(%s)', signature)

    const request = new grpcPuppet.ContactSelfSignatureRequest()
    request.setSignature(signature)

    await util.promisify(
      this.grpc.client.contactSelfSignature
        .bind(this.grpc.client),
    )(request)
  }

  /**
   *
   * Conversation
   *
   */
  override conversationReadMark (
    conversationId: string,
    hasRead = true,
  ) : Promise<void> {
    log.verbose('PuppetService', 'conversationMarkRead(%s, %s)', conversationId, hasRead)
    return PUPPET.throwUnsupportedError('not implemented. See https://github.com/wechaty/wechaty-puppet/pull/132')
  }

  /**
   *
   * Message
   *
   */
  override async messageMiniProgram (
    messageId: string,
  ): Promise<PUPPET.payload.MiniProgram> {
    log.verbose('PuppetService', 'messageMiniProgram(%s)', messageId)

    const request = new grpcPuppet.MessageMiniProgramRequest()
    request.setId(messageId)

    const response = await util.promisify(
      this.grpc.client.messageMiniProgram
        .bind(this.grpc.client),
    )(request)

    let miniProgramPayload = response.getMiniProgram()?.toObject()
    if (!miniProgramPayload) {
      /**
       * Deprecated: will be removed after Dec 22, 2022
       */
      const jsonText = response.getMiniProgramDeprecated()
      miniProgramPayload = JSON.parse(jsonText)
    }

    const payload: PUPPET.payload.MiniProgram = {
      ...miniProgramPayload,
    }

    return payload
  }

  override async messageLocation (
    messageId: string,
  ): Promise<PUPPET.payload.Location> {
    log.verbose('PuppetService', 'messageLocation(%s)', messageId)

    const request = new grpcPuppet.MessageLocationRequest()
    request.setId(messageId)

    const response = await util.promisify(
      this.grpc.client.messageLocation
        .bind(this.grpc.client),
    )(request)

    const locationPayload = response.getLocation()
    const payload: PUPPET.payload.Location = {
      accuracy  : 0,
      address   : 'NOADDRESS',
      latitude  : 0,
      longitude : 0,
      name      : 'NONAME',
      ...locationPayload,
    }

    return payload
  }

  override async messageImage (
    messageId: string,
    imageType: PUPPET.type.Image,
  ): Promise<FileBoxInterface> {
    log.verbose('PuppetService', 'messageImage(%s, %s[%s])',
      messageId,
      imageType,
      PUPPET.type.Image[imageType],
    )

    try {
      const request = new grpcPuppet.MessageImageRequest()
      request.setId(messageId)
      request.setType(imageType)

      const response = await util.promisify(
        this.grpc.client.messageImage
          .bind(this.grpc.client),
      )(request)

      const jsonText = response.getFileBox()

      if (jsonText) {
        return this.FileBoxUuid.fromJSON(jsonText)
      }

    } catch (e) {
      log.verbose('PuppetService', 'messageImage() rejection %s', (e as Error).message)
    }

    {
      // Deprecated. Will be removed after Dec 31, 2022
      const request = new grpcPuppet.MessageImageStreamRequest()
      request.setId(messageId)
      request.setType(imageType)

      const pbStream = this.grpc.client.messageImageStream(request)
      const fileBox = await unpackFileBoxFromPb(pbStream)
      // const fileBoxChunkStream = unpackFileBoxChunk(stream)
      // return unpackFileBox(fileBoxChunkStream)
      return fileBox
    }
  }

  override async messageContact (
    messageId: string,
  ): Promise<string> {
    log.verbose('PuppetService', 'messageContact(%s)', messageId)

    const request = new grpcPuppet.MessageContactRequest()
    request.setId(messageId)

    const response = await util.promisify(
      this.grpc.client.messageContact
        .bind(this.grpc.client),
    )(request)

    const contactId = response.getId()
    return contactId
  }

  override async messageSendMiniProgram (
    conversationId     : string,
    miniProgramPayload : PUPPET.payload.MiniProgram,
  ): Promise<void | string> {
    log.verbose('PuppetService', 'messageSendMiniProgram(%s, "%s")', conversationId, JSON.stringify(miniProgramPayload))

    const request = new grpcPuppet.MessageSendMiniProgramRequest()
    request.setConversationId(conversationId)

    const pbMiniProgramPayload = new grpcPuppet.MiniProgramPayload()
    if (miniProgramPayload.appid)       { pbMiniProgramPayload.setAppid(miniProgramPayload.appid) }
    if (miniProgramPayload.description) { pbMiniProgramPayload.setDescription(miniProgramPayload.description) }
    if (miniProgramPayload.iconUrl)     { pbMiniProgramPayload.setIconUrl(miniProgramPayload.iconUrl) }
    if (miniProgramPayload.pagePath)    { pbMiniProgramPayload.setPagePath(miniProgramPayload.pagePath) }
    if (miniProgramPayload.shareId)     { pbMiniProgramPayload.setShareId(miniProgramPayload.shareId) }
    if (miniProgramPayload.thumbKey)    { pbMiniProgramPayload.setThumbKey(miniProgramPayload.thumbKey) }
    if (miniProgramPayload.thumbUrl)    { pbMiniProgramPayload.setThumbUrl(miniProgramPayload.thumbUrl) }
    if (miniProgramPayload.title)       { pbMiniProgramPayload.setTitle(miniProgramPayload.title) }
    if (miniProgramPayload.username)    { pbMiniProgramPayload.setUsername(miniProgramPayload.username) }
    request.setMiniProgram(pbMiniProgramPayload)

    /**
     * Deprecated: will be removed after Dec 31, 2022
     */
    request.setMiniProgramDeprecated(JSON.stringify(miniProgramPayload))

    const response = await util.promisify(
      this.grpc.client.messageSendMiniProgram
        .bind(this.grpc.client),
    )(request)

    const messageId = response.getId()

    if (messageId) {
      return messageId
    }

    {
      /**
       * Huan(202110): Deprecated: will be removed after Dec 31, 2022
       */
      const messageIdWrapper = response.getIdStringValueDeprecated()

      if (messageIdWrapper) {
        return messageIdWrapper.getValue()
      }
    }
  }

  override async messageSendLocation (
    conversationId: string,
    locationPayload: PUPPET.payload.Location,
  ): Promise<void | string> {
    log.verbose('PuppetService', 'messageSendLocation(%s)', conversationId, JSON.stringify(locationPayload))

    const request = new grpcPuppet.MessageSendLocationRequest()
    request.setConversationId(conversationId)

    const pbLocationPayload = new grpcPuppet.LocationPayload()
    pbLocationPayload.setAccuracy(locationPayload.accuracy)
    pbLocationPayload.setAddress(locationPayload.address)
    pbLocationPayload.setLatitude(locationPayload.latitude)
    pbLocationPayload.setLongitude(locationPayload.longitude)
    pbLocationPayload.setName(locationPayload.name)
    request.setLocation(pbLocationPayload)

    const response = await util.promisify(
      this.grpc.client.messageSendLocation
        .bind(this.grpc.client),
    )(request)

    const id = response.getId()

    if (id) {
      return id
    }
  }

  override async messageRecall (
    messageId: string,
  ): Promise<boolean> {
    log.verbose('PuppetService', 'messageRecall(%s)', messageId)

    const request = new grpcPuppet.MessageRecallRequest()
    request.setId(messageId)

    const response = await util.promisify(
      this.grpc.client.messageRecall
        .bind(this.grpc.client),
    )(request)

    return response.getSuccess()
  }

  override async messageFile (id: string): Promise<FileBoxInterface> {
    log.verbose('PuppetService', 'messageFile(%s)', id)

    try {
      const request = new grpcPuppet.MessageFileRequest()
      request.setId(id)
      const response = await util.promisify(
        this.grpc.client.messageFile
          .bind(this.grpc.client),
      )(request)

      const jsonText = response.getFileBox()
      if (jsonText) {
        return this.FileBoxUuid.fromJSON(jsonText)
      }
    } catch (e) {
      log.warn('PuppetService', 'messageFile() rejection: %s', (e as Error).message)
      log.warn('PuppetService', [
        'This might because you are using Wechaty v1.x with a Puppet Service v0.x',
        'Contact your Wechaty Puppet Service provided to report this problem',
        'Related issues:',
        ' - https://github.com/wechaty/puppet-service/issues/179',
        ' - https://github.com/wechaty/puppet-service/pull/170',
      ].join('\n'))
    }

    {
      // Deprecated. `MessageFileStream` Will be removed after Dec 31, 2022
      const request = new grpcPuppet.MessageFileStreamRequest()
      request.setId(id)

      const pbStream = this.grpc.client.messageFileStream(request)
      // const fileBoxChunkStream = unpackFileBoxChunk(pbStream)
      // return unpackFileBox(fileBoxChunkStream)
      const fileBox = await unpackFileBoxFromPb(pbStream)
      return fileBox
    }
  }

  override async messageForward (
    conversationId: string,
    messageId: string,
  ): Promise<string | void> {
    log.verbose('PuppetService', 'messageForward(%s, %s)', conversationId, messageId)

    const request = new grpcPuppet.MessageForwardRequest()
    request.setConversationId(conversationId)
    request.setMessageId(messageId)

    const response = await util.promisify(
      this.grpc.client.messageForward
        .bind(this.grpc.client),
    )(request)

    const forwardedMessageId = response.getId()

    if (forwardedMessageId) {
      return forwardedMessageId
    }

    {
      /**
       * Huan(202110): Deprecated: will be removed after Dec 31, 2022
       */
      const messageIdWrapper = response.getIdStringValueDeprecated()

      if (messageIdWrapper) {
        return messageIdWrapper.getValue()
      }
    }
  }

  override async messageRawPayload (id: string): Promise<PUPPET.payload.Message> {
    log.verbose('PuppetService', 'messageRawPayload(%s)', id)

    // const cachedPayload = await this.payloadStore.message?.get(id)
    // if (cachedPayload) {
    //   log.silly('PuppetService', 'messageRawPayload(%s) cache HIT', id)
    //   return cachedPayload
    // }

    const request = new grpcPuppet.MessagePayloadRequest()
    request.setId(id)

    const response = await util.promisify(
      this.grpc.client.messagePayload
        .bind(this.grpc.client),
    )(request)

    let timestamp
    const receiveTime = response.getReceiveTime()
    if (receiveTime) {
      timestamp = millisecondsFromTimestamp(receiveTime)
    } else {
      // Deprecated: will be removed after Dec 31, 2022
      timestamp = response.getTimestampDeprecated()
    }

    const payload: PUPPET.payload.Message = {
      filename      : response.getFilename(),
      fromId        : response.getFromId(),
      id            : response.getId(),
      mentionIdList : response.getMentionIdsList(),
      roomId        : response.getRoomId(),
      text          : response.getText(),
      timestamp,
      toId          : response.getToId(),
      type          : response.getType() as number,
    }

    // log.silly('PuppetService', 'messageRawPayload(%s) cache SET', id)
    // await this.payloadStore.message?.set(id, payload)

    return payload
  }

  override async messageRawPayloadParser (payload: PUPPET.payload.Message): Promise<PUPPET.payload.Message> {
    // log.silly('PuppetService', 'messagePayload({id:%s})', payload.id)
    // passthrough
    return payload
  }

  override async messageSendText (
    conversationId : string,
    text           : string,
    mentionIdList? : string[],
  ): Promise<void | string> {
    log.verbose('PuppetService', 'messageSend(%s, %s)', conversationId, text)

    const request = new grpcPuppet.MessageSendTextRequest()
    request.setConversationId(conversationId)
    request.setText(text)
    if (typeof mentionIdList !== 'undefined') {
      request.setMentionalIdsList(mentionIdList)
    }

    const response = await util.promisify(
      this.grpc.client.messageSendText
        .bind(this.grpc.client),
    )(request)

    const messageId = response.getId()

    if (messageId) {
      return messageId
    }

    {
      /**
       * Huan(202110): Deprecated: will be removed after Dec 31, 2022
       */
      const messageIdWrapper = response.getIdStringValueDeprecated()

      if (messageIdWrapper) {
        return messageIdWrapper.getValue()
      }
    }
  }

  override async messageSendFile (
    conversationId : string,
    fileBox        : FileBoxInterface,
  ): Promise<void | string> {
    log.verbose('PuppetService', 'messageSendFile(%s, %s)', conversationId, fileBox)

    try {
      const request = new grpcPuppet.MessageSendFileRequest()
      request.setConversationId(conversationId)

      const serializedFileBox = await this.serializeFileBox(fileBox)
      request.setFileBox(serializedFileBox)

      const response = await util.promisify(
        this.grpc.client.messageSendFile
          .bind(this.grpc.client),
      )(request)

      const messageId = response.getId()

      if (messageId) {
        return messageId
      } else {
        /**
         * Huan(202110): Deprecated: will be removed after Dec 31, 2022
         */
        const messageIdWrapper = response.getIdStringValueDeprecated()
        if (messageIdWrapper) {
          return messageIdWrapper.getValue()
        }
      }

      return // void

    } catch (e) {
      log.verbose('PuppetService', 'messageSendFile() rejection: %s', (e as Error).message)
    }

    /**
     * Huan(202110): Deprecated: will be removed after Dec 31, 2022
     *  The old server will not support `Upload` gRPC method,
     *  which I'm expecting the above code will throw a exception,
     *  then the below code will be executed.
     */
    return this.messageSendFileStream(conversationId, fileBox)
  }

  override async messageSendContact (
    conversationId  : string,
    contactId       : string,
  ): Promise<void | string> {
    log.verbose('PuppetService', 'messageSend("%s", %s)', conversationId, contactId)

    const request = new grpcPuppet.MessageSendContactRequest()
    request.setConversationId(conversationId)
    request.setContactId(contactId)

    const response = await util.promisify(
      this.grpc.client.messageSendContact
        .bind(this.grpc.client),
    )(request)

    const messageId = response.getId()

    if (messageId) {
      return messageId
    }

    {
      /**
       * Huan(202110): Deprecated: will be removed after Dec 31, 2022
       */
      const messageIdWrapper = response.getIdStringValueDeprecated()

      if (messageIdWrapper) {
        return messageIdWrapper.getValue()
      }
    }
  }

  override async messageSendUrl (
    conversationId: string,
    urlLinkPayload: PUPPET.payload.UrlLink,
  ): Promise<void | string> {
    log.verbose('PuppetService', 'messageSendUrl("%s", %s)', conversationId, JSON.stringify(urlLinkPayload))

    const request = new grpcPuppet.MessageSendUrlRequest()
    request.setConversationId(conversationId)

    const pbUrlLinkPayload = new grpcPuppet.UrlLinkPayload()
    pbUrlLinkPayload.setUrl(urlLinkPayload.url)
    pbUrlLinkPayload.setTitle(urlLinkPayload.title)
    if (urlLinkPayload.description)   { pbUrlLinkPayload.setDescription(urlLinkPayload.description) }
    if (urlLinkPayload.thumbnailUrl)  { pbUrlLinkPayload.setThumbnailUrl(urlLinkPayload.thumbnailUrl) }
    request.setUrlLink(pbUrlLinkPayload)

    // Deprecated: will be removed after Dec 31, 2022
    request.setUrlLinkDeprecated(JSON.stringify(urlLinkPayload))

    const response = await util.promisify(
      this.grpc.client.messageSendUrl
        .bind(this.grpc.client),
    )(request)

    const messageId = response.getId()

    if (messageId) {
      return messageId
    }

    {
      /**
       * Huan(202110): Deprecated: will be removed after Dec 31, 2022
       */
      const messageIdWrapper = response.getIdStringValueDeprecated()

      if (messageIdWrapper) {
        return messageIdWrapper.getValue()
      }
    }
  }

  override async messageUrl (messageId: string): Promise<PUPPET.payload.UrlLink> {
    log.verbose('PuppetService', 'messageUrl(%s)', messageId)

    const request = new grpcPuppet.MessageUrlRequest()
    request.setId(messageId)

    const response = await util.promisify(
      this.grpc.client.messageUrl
        .bind(this.grpc.client),
    )(request)

    let pbUrlLinkPayload = response.getUrlLink()?.toObject()
    if (!pbUrlLinkPayload) {
      // Deprecated: will be removed after Dec 31, 2022
      const jsonText = response.getUrlLinkDeprecated()
      pbUrlLinkPayload = JSON.parse(jsonText)
    }

    const payload: PUPPET.payload.UrlLink = {
      title : 'NOTITLE',
      url   : 'NOURL',
      ...pbUrlLinkPayload,
    }
    return payload
  }

  /**
   *
   * Room
   *
   */
  override async roomRawPayload (
    id: string,
  ): Promise<PUPPET.payload.Room> {
    log.verbose('PuppetService', 'roomRawPayload(%s)', id)

    const cachedPayload = await this.payloadStore.room?.get(id)
    if (cachedPayload) {
      log.silly('PuppetService', 'roomRawPayload(%s) cache HIT', id)
      return cachedPayload
    }

    const request = new grpcPuppet.RoomPayloadRequest()
    request.setId(id)

    const response = await util.promisify(
      this.grpc.client.roomPayload
        .bind(this.grpc.client),
    )(request)

    const payload: PUPPET.payload.Room = {
      adminIdList  : response.getAdminIdsList(),
      avatar       : response.getAvatar(),
      id           : response.getId(),
      memberIdList : response.getMemberIdsList(),
      ownerId      : response.getOwnerId(),
      topic        : response.getTopic(),
    }

    await this.payloadStore.room?.set(id, payload)
    log.silly('PuppetService', 'roomRawPayload(%s) cache SET', id)

    return payload
  }

  override async roomRawPayloadParser (payload: PUPPET.payload.Room): Promise<PUPPET.payload.Room> {
    // log.silly('PuppetService', 'roomRawPayloadParser({id:%s})', payload.id)
    // passthrough
    return payload
  }

  override async roomList (): Promise<string[]> {
    log.verbose('PuppetService', 'roomList()')

    const response = await util.promisify(
      this.grpc.client.roomList
        .bind(this.grpc.client),
    )(new grpcPuppet.RoomListRequest())

    return response.getIdsList()
  }

  override async roomDel (
    roomId    : string,
    contactId : string,
  ): Promise<void> {
    log.verbose('PuppetService', 'roomDel(%s, %s)', roomId, contactId)

    const request = new grpcPuppet.RoomDelRequest()
    request.setId(roomId)
    request.setContactId(contactId)

    await util.promisify(
      this.grpc.client.roomDel
        .bind(this.grpc.client),
    )(request)
  }

  override async roomAvatar (roomId: string): Promise<FileBoxInterface> {
    log.verbose('PuppetService', 'roomAvatar(%s)', roomId)

    const request = new grpcPuppet.RoomAvatarRequest()
    request.setId(roomId)

    const response = await util.promisify(
      this.grpc.client.roomAvatar
        .bind(this.grpc.client),
    )(request)

    const jsonText = response.getFileBox()
    return this.FileBoxUuid.fromJSON(jsonText)
  }

  override async roomAdd (
    roomId     : string,
    contactId  : string,
    inviteOnly : boolean,
  ): Promise<void> {
    log.verbose('PuppetService', 'roomAdd(%s, %s)', roomId, contactId)

    const request = new grpcPuppet.RoomAddRequest()
    request.setId(roomId)
    request.setContactId(contactId)
    request.setInviteOnly(inviteOnly)

    await util.promisify(
      this.grpc.client.roomAdd
        .bind(this.grpc.client),
    )(request)
  }

  override async roomTopic (roomId: string)                : Promise<string>
  override async roomTopic (roomId: string, topic: string) : Promise<void>

  override async roomTopic (
    roomId: string,
    topic?: string,
  ): Promise<void | string> {
    log.verbose('PuppetService', 'roomTopic(%s, %s)', roomId, topic)

    /**
     * Get
     */
    if (typeof topic === 'undefined') {
      const request = new grpcPuppet.RoomTopicRequest()
      request.setId(roomId)

      const response = await util.promisify(
        this.grpc.client.roomTopic
          .bind(this.grpc.client),
      )(request)

      const result = response.getTopic()
      if (result) {
        return result
      }

      {
        // DEPRECATED, will be removed after Dec 31, 2022
        const topicWrapper = response.getTopicStringValueDeprecated()
        if (topicWrapper) {
          return topicWrapper.getValue()
        }
      }

      return ''
    }

    /**
     * Set
     */
    const request = new grpcPuppet.RoomTopicRequest()
    request.setId(roomId)
    request.setTopic(topic)

    {
      // DEPRECATED, will be removed after Dec 31, 2022
      const topicWrapper = new StringValue()
      topicWrapper.setValue(topic)

      request.setTopicStringValueDeprecated(topicWrapper)
    }

    await util.promisify(
      this.grpc.client.roomTopic
        .bind(this.grpc.client),
    )(request)
  }

  override async roomCreate (
    contactIdList : string[],
    topic         : string,
  ): Promise<string> {
    log.verbose('PuppetService', 'roomCreate(%s, %s)', contactIdList, topic)

    const request = new grpcPuppet.RoomCreateRequest()
    request.setContactIdsList(contactIdList)
    request.setTopic(topic)

    const response = await util.promisify(
      this.grpc.client.roomCreate
        .bind(this.grpc.client),
    )(request)

    return response.getId()
  }

  override async roomQuit (roomId: string): Promise<void> {
    log.verbose('PuppetService', 'roomQuit(%s)', roomId)

    const request = new grpcPuppet.RoomQuitRequest()
    request.setId(roomId)

    await util.promisify(
      this.grpc.client.roomQuit
        .bind(this.grpc.client),
    )(request)
  }

  override async roomQRCode (roomId: string): Promise<string> {
    log.verbose('PuppetService', 'roomQRCode(%s)', roomId)

    const request = new grpcPuppet.RoomQRCodeRequest()
    request.setId(roomId)

    const response = await util.promisify(
      this.grpc.client.roomQRCode
        .bind(this.grpc.client),
    )(request)

    return response.getQrcode()
  }

  override async roomMemberList (roomId: string) : Promise<string[]> {
    log.verbose('PuppetService', 'roomMemberList(%s)', roomId)

    const request = new grpcPuppet.RoomMemberListRequest()
    request.setId(roomId)

    const response = await util.promisify(
      this.grpc.client.roomMemberList
        .bind(this.grpc.client),
    )(request)

    return response.getMemberIdsList()
  }

  override async roomMemberRawPayload (roomId: string, contactId: string): Promise<any>  {
    log.verbose('PuppetService', 'roomMemberRawPayload(%s, %s)', roomId, contactId)

    const id = this.payloadStore.roomMemberId(roomId, contactId)
    const cachedPayload = await this.payloadStore.roomMember?.get(id)
    if (cachedPayload) {
      log.silly('PuppetService', 'roomMemberRawPayload(%s) cache HIT', id)
      return cachedPayload
    }

    const request = new grpcPuppet.RoomMemberPayloadRequest()
    request.setId(roomId)
    request.setMemberId(contactId)

    const response = await util.promisify(
      this.grpc.client.roomMemberPayload
        .bind(this.grpc.client),
    )(request)

    const payload: PUPPET.payload.RoomMember = {
      avatar    : response.getAvatar(),
      id        : response.getId(),
      inviterId : response.getInviterId(),
      name      : response.getName(),
      roomAlias : response.getRoomAlias(),
    }

    await this.payloadStore.roomMember?.set(id, payload)
    log.silly('PuppetService', 'roomMemberRawPayload(%s) cache SET', id)

    return payload
  }

  override async roomMemberRawPayloadParser (payload: any): Promise<PUPPET.payload.RoomMember>  {
    // log.silly('PuppetService', 'roomMemberRawPayloadParser({id:%s})', payload.id)
    // passthrough
    return payload
  }

  override async roomAnnounce (roomId: string)                : Promise<string>
  override async roomAnnounce (roomId: string, text: string)  : Promise<void>

  override async roomAnnounce (roomId: string, text?: string) : Promise<void | string> {
    log.verbose('PuppetService', 'roomAnnounce(%s%s)',
      roomId,
      typeof text === 'undefined'
        ? ''
        : `, ${text}`,
    )

    /**
     * Set
     */
    if (text) {
      const request = new grpcPuppet.RoomAnnounceRequest()
      request.setId(roomId)
      request.setText(text)

      {
        // DEPRECATED, will be removed after Dec 31, 2022
        const textWrapper = new StringValue()
        textWrapper.setValue(text)
        request.setTextStringValueDeprecated(textWrapper)
      }

      await util.promisify(
        this.grpc.client.roomAnnounce
          .bind(this.grpc.client),
      )(request)

      return
    }

    /**
     * Get
     */
    const request = new grpcPuppet.RoomAnnounceRequest()
    request.setId(roomId)

    const response = await util.promisify(
      this.grpc.client.roomAnnounce
        .bind(this.grpc.client),
    )(request)

    const result = response.getText()
    if (result) {
      return result
    }

    {
      // DEPRECATED, will be removed after Dec 31, 2022
      const textWrapper = response.getTextStringValueDeprecated()
      if (textWrapper) {
        return textWrapper.getValue()
      }
    }

    return ''
  }

  override async roomInvitationAccept (
    roomInvitationId: string,
  ): Promise<void> {
    log.verbose('PuppetService', 'roomInvitationAccept(%s)', roomInvitationId)

    const request = new grpcPuppet.RoomInvitationAcceptRequest()
    request.setId(roomInvitationId)

    await util.promisify(
      this.grpc.client.roomInvitationAccept
        .bind(this.grpc.client),
    )(request)
  }

  override async roomInvitationRawPayload (
    id: string,
  ): Promise<PUPPET.payload.RoomInvitation> {
    log.verbose('PuppetService', 'roomInvitationRawPayload(%s)', id)

    const request = new grpcPuppet.RoomInvitationPayloadRequest()
    request.setId(id)

    const response = await util.promisify(
      this.grpc.client.roomInvitationPayload
        .bind(this.grpc.client),
    )(request)

    let timestamp
    const receiveTime = response.getReceiveTime()
    if (receiveTime) {
      timestamp = millisecondsFromTimestamp(receiveTime)
    }

    {
      // Deprecated: will be removed after Dec 31, 2022
      const deprecated = true
      void deprecated

      if (!receiveTime) {
        timestamp = response.getTimestampUint64Deprecated()
      }
    }

    // FIXME: how to set it better?
    timestamp ??= 0

    const payload: PUPPET.payload.RoomInvitation = {
      avatar       : response.getAvatar(),
      id           : response.getId(),
      invitation   : response.getInvitation(),
      inviterId    : response.getInviterId(),
      memberCount  : response.getMemberCount(),
      memberIdList : response.getMemberIdsList(),
      receiverId   : response.getReceiverId(),
      timestamp,
      topic        : response.getTopic(),
    }

    return payload
  }

  override async roomInvitationRawPayloadParser (payload: PUPPET.payload.RoomInvitation): Promise<PUPPET.payload.RoomInvitation> {
    // log.silly('PuppetService', 'roomInvitationRawPayloadParser({id:%s})', payload.id)
    // passthrough
    return payload
  }

  /**
   *
   * Friendship
   *
   */
  override async friendshipSearchPhone (
    phone: string,
  ): Promise<string | null> {
    log.verbose('PuppetService', 'friendshipSearchPhone(%s)', phone)

    const request = new grpcPuppet.FriendshipSearchPhoneRequest()
    request.setPhone(phone)

    const response = await util.promisify(
      this.grpc.client.friendshipSearchPhone
        .bind(this.grpc.client),
    )(request)

    const contactId = response.getContactId()
    if (contactId) {
      return contactId
    }

    {
      // DEPRECATED, will be removed after Dec 31, 2022
      const contactIdWrapper = response.getContactIdStringValueDeprecated()
      if (contactIdWrapper) {
        return contactIdWrapper.getValue()
      }
    }

    return null
  }

  override async friendshipSearchWeixin (
    weixin: string,
  ): Promise<string | null> {
    log.verbose('PuppetService', 'friendshipSearchWeixin(%s)', weixin)

    const request = new grpcPuppet.FriendshipSearchWeixinRequest()
    request.setWeixin(weixin)

    const response = await util.promisify(
      this.grpc.client.friendshipSearchWeixin
        .bind(this.grpc.client),
    )(request)

    const contactId = response.getContactId()
    if (contactId) {
      return contactId
    }

    {
      // DEPRECATED, will be removed after Dec 31, 2022
      const contactIdWrapper = response.getContactIdStringValueDeprecated()
      if (contactIdWrapper) {
        return contactIdWrapper.getValue()
      }
    }

    return null
  }

  override async friendshipRawPayload (id: string): Promise<PUPPET.payload.Friendship> {
    log.verbose('PuppetService', 'friendshipRawPayload(%s)', id)

    const request = new grpcPuppet.FriendshipPayloadRequest()
    request.setId(id)

    const response = await util.promisify(
      this.grpc.client.friendshipPayload
        .bind(this.grpc.client),
    )(request)

    const payload: PUPPET.payload.Friendship = {
      contactId : response.getContactId(),
      hello: response.getHello(),
      id,
      scene     : response.getScene() as number,
      stranger  : response.getStranger(),
      ticket    : response.getTicket(),
      type      : response.getType() as number,
    } as any  // FIXME: Huan(202002)

    return payload
  }

  override async friendshipRawPayloadParser (payload: PUPPET.payload.Friendship) : Promise<PUPPET.payload.Friendship> {
    // log.silly('PuppetService', 'friendshipRawPayloadParser({id:%s})', payload.id)
    // passthrough
    return payload
  }

  override async friendshipAdd (
    contactId : string,
    options   : PUPPET.type.FriendshipAddOptions,
  ): Promise<void> {
    log.verbose('PuppetService', 'friendshipAdd(%s, %s)', contactId, JSON.stringify(options))

    const request = new grpcPuppet.FriendshipAddRequest()
    request.setContactId(contactId)

    // FIXME: for backward compatibility, need to be removed after all puppet has updated.
    if (typeof options === 'string') {
      request.setHello(options)
    } else {
      request.setHello(options.hello!)

      const referrer = new grpcPuppet.Referrer()
      if (options.contactId)  { referrer.setContactId(options.contactId) }
      if (options.roomId)     { referrer.setRoomId(options.roomId) }
      request.setReferrer(referrer)

      {
        // Deprecated: will be removed after Dec 31, 2022
        const contactIdWrapper = new StringValue()
        contactIdWrapper.setValue(options.contactId || '')
        const roomIdWrapper = new StringValue()
        roomIdWrapper.setValue(options.roomId || '')
        request.setSourceRoomIdStringValueDeprecated(roomIdWrapper)
        request.setSourceContactIdStringValueDeprecated(contactIdWrapper)
      }
    }

    await util.promisify(
      this.grpc.client.friendshipAdd
        .bind(this.grpc.client),
    )(request)
  }

  override async friendshipAccept (
    friendshipId : string,
  ): Promise<void> {
    log.verbose('PuppetService', 'friendshipAccept(%s)', friendshipId)

    const request = new grpcPuppet.FriendshipAcceptRequest()
    request.setId(friendshipId)

    await util.promisify(
      this.grpc.client.friendshipAccept
        .bind(this.grpc.client),
    )(request)
  }

  /**
   *
   * Tag
   *
   */
  // add a tag for a Contact. Create it first if it not exist.
  override async tagContactAdd (
    id: string,
    contactId: string,
  ): Promise<void> {
    log.verbose('PuppetService', 'tagContactAdd(%s, %s)', id, contactId)

    const request = new grpcPuppet.TagContactAddRequest()
    request.setId(id)
    request.setContactId(contactId)

    await util.promisify(
      this.grpc.client.tagContactAdd
        .bind(this.grpc.client),
    )(request)
  }

  // remove a tag from the Contact
  override async tagContactRemove (
    id: string,
    contactId: string,
  ) : Promise<void> {
    log.verbose('PuppetService', 'tagContactRemove(%s, %s)', id, contactId)

    const request = new grpcPuppet.TagContactRemoveRequest()
    request.setId(id)
    request.setContactId(contactId)

    await util.promisify(
      this.grpc.client.tagContactRemove
        .bind(this.grpc.client),
    )(request)
  }

  // delete a tag from Wechat
  override async tagContactDelete (
    id: string,
  ) : Promise<void> {
    log.verbose('PuppetService', 'tagContactDelete(%s)', id)

    const request = new grpcPuppet.TagContactDeleteRequest()
    request.setId(id)

    await util.promisify(
      this.grpc.client.tagContactDelete
        .bind(this.grpc.client),
    )(request)
  }

  // get tags from a specific Contact
  override async tagContactList (
    contactId?: string,
  ) : Promise<string[]> {
    log.verbose('PuppetService', 'tagContactList(%s)', contactId)

    const request = new grpcPuppet.TagContactListRequest()

    if (typeof contactId !== 'undefined') {
      request.setContactId(contactId)
      {

        /**
         * Huan(202110): Deprecated: will be removed after Dec 31, 2022
         */
        const contactIdWrapper = new StringValue()
        contactIdWrapper.setValue(contactId)
        request.setContactIdStringValueDeprecated(contactIdWrapper)
      }
    }

    const response = await util.promisify(
      this.grpc.client.tagContactList
        .bind(this.grpc.client),
    )(request)

    return response.getIdsList()
  }

  /**
   * @deprecated Will be removed after Dec 31, 2022
   */
  private async messageSendFileStream (
    conversationId : string,
    file           : FileBoxInterface,
  ): Promise<void | string> {
    const request = await packConversationIdFileBoxToPb(grpcPuppet.MessageSendFileStreamRequest)(conversationId, file)

    const response = await new Promise<grpcPuppet.MessageSendFileStreamResponse>((resolve, reject) => {
      const stream = this.grpc.client.messageSendFileStream((err, response) => {
        if (err) {
          reject(err)
        } else {
          resolve(response)
        }
      })
      request.pipe(stream)
    })

    const messageId = response.getId()

    if (messageId) {
      return messageId
    }

    {
      /**
       * Huan(202110): Deprecated: will be removed after Dec 31, 2022
       */
      const messageIdWrapper = response.getIdStringValueDeprecated()
      if (messageIdWrapper) {
        return messageIdWrapper.getValue()
      }
    }
  }

}

export default PuppetService
