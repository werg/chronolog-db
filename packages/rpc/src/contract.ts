import type {
  AddAssertionIrRequest,
  AddExpectationRequest,
  AddMutationIrRequest,
  BeginDraftRequest,
  BeginDraftResponse,
  CancelDraftRequest,
  CancelDraftResponse,
  DraftMutationResponse,
  ExecuteIrRequest,
  ExecuteIrResponse,
  GetOutcomeRequest,
  GetReplicationStatusRequest,
  GetSettlementEvidenceRequest,
  GetStatusRequest,
  GetValidatorWatermarkRequest,
  LiveIrEvent,
  LiveIrRequest,
  LocalSqlRequest,
  LocalSqlResponse,
  NodeStatus,
  ObserveIrRequest,
  ObserveIrResponse,
  PublishDraftRequest,
  PublishDraftResponse,
  RebaseDraftRequest,
  RebaseDraftResponse,
  ReplicationStatus,
  SettlementEvidence,
  StreamOutcomeRequest,
  StreamReplicationStatusRequest,
  StreamSettlementEvidenceRequest,
  StreamStatusRequest,
  TransactionOutcome,
  ValidateDraftRequest,
  ValidateDraftResponse,
  ValidatorWatermark,
} from './types.js'

export interface RpcCallOptions {
  readonly signal?: AbortSignal
  readonly token?: string
  readonly timeoutMs?: number
  readonly metadata?: Readonly<Record<string, string>>
}

export interface RpcCallContext extends RpcCallOptions {
  readonly method: RpcMethod
  readonly peer?: string
}

export interface UnaryRpcMethods {
  'node.getStatus': { request: GetStatusRequest; response: NodeStatus }
  'query.executeIr': { request: ExecuteIrRequest; response: ExecuteIrResponse }
  'query.localSql': { request: LocalSqlRequest; response: LocalSqlResponse }
  'transaction.beginDraft': { request: BeginDraftRequest; response: BeginDraftResponse }
  'transaction.observeIr': { request: ObserveIrRequest; response: ObserveIrResponse }
  'transaction.addAssertionIr': { request: AddAssertionIrRequest; response: DraftMutationResponse }
  'transaction.addExpectation': { request: AddExpectationRequest; response: DraftMutationResponse }
  'transaction.addMutationIr': { request: AddMutationIrRequest; response: DraftMutationResponse }
  'transaction.validateDraft': { request: ValidateDraftRequest; response: ValidateDraftResponse }
  'transaction.rebaseDraft': { request: RebaseDraftRequest; response: RebaseDraftResponse }
  'transaction.cancelDraft': { request: CancelDraftRequest; response: CancelDraftResponse }
  'transaction.publishDraft': { request: PublishDraftRequest; response: PublishDraftResponse }
  'transaction.getOutcome': { request: GetOutcomeRequest; response: TransactionOutcome }
  'evidence.getSettlement': { request: GetSettlementEvidenceRequest; response: SettlementEvidence }
  'evidence.getValidatorWatermark': { request: GetValidatorWatermarkRequest; response: ValidatorWatermark }
  'node.getReplicationStatus': { request: GetReplicationStatusRequest; response: ReplicationStatus }
}

export interface StreamRpcMethods {
  'node.streamStatus': { request: StreamStatusRequest; response: NodeStatus }
  'query.liveIr': { request: LiveIrRequest; response: LiveIrEvent }
  'transaction.streamOutcome': { request: StreamOutcomeRequest; response: TransactionOutcome }
  'evidence.streamSettlement': { request: StreamSettlementEvidenceRequest; response: SettlementEvidence }
  'node.streamReplicationStatus': { request: StreamReplicationStatusRequest; response: ReplicationStatus }
}

export type UnaryRpcMethod = keyof UnaryRpcMethods
export type StreamRpcMethod = keyof StreamRpcMethods
export type RpcMethod = UnaryRpcMethod | StreamRpcMethod
export type UnaryRequest<M extends UnaryRpcMethod> = UnaryRpcMethods[M]['request']
export type UnaryResponse<M extends UnaryRpcMethod> = UnaryRpcMethods[M]['response']
export type StreamRequest<M extends StreamRpcMethod> = StreamRpcMethods[M]['request']
export type StreamResponse<M extends StreamRpcMethod> = StreamRpcMethods[M]['response']

export interface RpcTransport {
  unary<M extends UnaryRpcMethod>(method: M, request: UnaryRequest<M>, options?: RpcCallOptions): Promise<UnaryResponse<M>>
  stream<M extends StreamRpcMethod>(method: M, request: StreamRequest<M>, options?: RpcCallOptions): AsyncIterable<StreamResponse<M>>
  close?(): Promise<void>
}

export interface ChronologRpcService {
  getStatus(request: GetStatusRequest, context: RpcCallContext): Promise<NodeStatus>
  streamStatus(request: StreamStatusRequest, context: RpcCallContext): AsyncIterable<NodeStatus>
  executeIr(request: ExecuteIrRequest, context: RpcCallContext): Promise<ExecuteIrResponse>
  liveIr(request: LiveIrRequest, context: RpcCallContext): AsyncIterable<LiveIrEvent>
  localSql(request: LocalSqlRequest, context: RpcCallContext): Promise<LocalSqlResponse>
  beginDraft(request: BeginDraftRequest, context: RpcCallContext): Promise<BeginDraftResponse>
  observeIr(request: ObserveIrRequest, context: RpcCallContext): Promise<ObserveIrResponse>
  addAssertionIr(request: AddAssertionIrRequest, context: RpcCallContext): Promise<DraftMutationResponse>
  addExpectation(request: AddExpectationRequest, context: RpcCallContext): Promise<DraftMutationResponse>
  addMutationIr(request: AddMutationIrRequest, context: RpcCallContext): Promise<DraftMutationResponse>
  validateDraft(request: ValidateDraftRequest, context: RpcCallContext): Promise<ValidateDraftResponse>
  rebaseDraft(request: RebaseDraftRequest, context: RpcCallContext): Promise<RebaseDraftResponse>
  cancelDraft(request: CancelDraftRequest, context: RpcCallContext): Promise<CancelDraftResponse>
  publishDraft(request: PublishDraftRequest, context: RpcCallContext): Promise<PublishDraftResponse>
  getOutcome(request: GetOutcomeRequest, context: RpcCallContext): Promise<TransactionOutcome>
  streamOutcome(request: StreamOutcomeRequest, context: RpcCallContext): AsyncIterable<TransactionOutcome>
  getSettlementEvidence(request: GetSettlementEvidenceRequest, context: RpcCallContext): Promise<SettlementEvidence>
  streamSettlementEvidence(request: StreamSettlementEvidenceRequest, context: RpcCallContext): AsyncIterable<SettlementEvidence>
  getValidatorWatermark(request: GetValidatorWatermarkRequest, context: RpcCallContext): Promise<ValidatorWatermark>
  getReplicationStatus(request: GetReplicationStatusRequest, context: RpcCallContext): Promise<ReplicationStatus>
  streamReplicationStatus(request: StreamReplicationStatusRequest, context: RpcCallContext): AsyncIterable<ReplicationStatus>
}

export interface ChronologService extends ChronologRpcService {}
