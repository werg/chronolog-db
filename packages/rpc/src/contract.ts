import type {
  AddPreconditionRequest,
  AddStatementsRequest,
  BeginDraftRequest,
  BeginDraftResponse,
  CancelDraftRequest,
  CancelDraftResponse,
  DraftMutationResponse,
  GetOutcomeRequest,
  GetReplicationStatusRequest,
  GetSettlementEvidenceRequest,
  GetStatusRequest,
  GetTransactionResultRequest,
  GetTransactionResultResponse,
  GetValidatorWatermarkRequest,
  LiveSqlEvent,
  LiveSqlRequest,
  LocalSqlRequest,
  LocalSqlResponse,
  NodeStatus,
  ObserveSqlRequest,
  ObserveSqlResponse,
  PublishDraftRequest,
  PublishDraftResponse,
  RebaseDraftRequest,
  RebaseDraftResponse,
  ReplaceStatementsRequest,
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

export interface RpcCallOptions { readonly signal?: AbortSignal; readonly token?: string; readonly timeoutMs?: number; readonly metadata?: Readonly<Record<string, string>> }
export interface RpcCallContext extends RpcCallOptions { readonly method: RpcMethod; readonly peer?: string }

export interface UnaryRpcMethods {
  'node.getStatus': { request: GetStatusRequest; response: NodeStatus }
  'query.localSql': { request: LocalSqlRequest; response: LocalSqlResponse }
  'transaction.beginDraft': { request: BeginDraftRequest; response: BeginDraftResponse }
  'transaction.observeSql': { request: ObserveSqlRequest; response: ObserveSqlResponse }
  'transaction.addPrecondition': { request: AddPreconditionRequest; response: DraftMutationResponse }
  'transaction.addStatements': { request: AddStatementsRequest; response: DraftMutationResponse }
  'transaction.replaceStatements': { request: ReplaceStatementsRequest; response: DraftMutationResponse }
  'transaction.validateDraft': { request: ValidateDraftRequest; response: ValidateDraftResponse }
  'transaction.rebaseDraft': { request: RebaseDraftRequest; response: RebaseDraftResponse }
  'transaction.cancelDraft': { request: CancelDraftRequest; response: CancelDraftResponse }
  'transaction.publishDraft': { request: PublishDraftRequest; response: PublishDraftResponse }
  'transaction.getOutcome': { request: GetOutcomeRequest; response: TransactionOutcome }
  'transaction.getResult': { request: GetTransactionResultRequest; response: GetTransactionResultResponse }
  'evidence.getSettlement': { request: GetSettlementEvidenceRequest; response: SettlementEvidence }
  'evidence.getValidatorWatermark': { request: GetValidatorWatermarkRequest; response: ValidatorWatermark }
  'node.getReplicationStatus': { request: GetReplicationStatusRequest; response: ReplicationStatus }
}
export interface StreamRpcMethods {
  'node.streamStatus': { request: StreamStatusRequest; response: NodeStatus }
  'query.liveSql': { request: LiveSqlRequest; response: LiveSqlEvent }
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
  localSql(request: LocalSqlRequest, context: RpcCallContext): Promise<LocalSqlResponse>
  liveSql(request: LiveSqlRequest, context: RpcCallContext): AsyncIterable<LiveSqlEvent>
  beginDraft(request: BeginDraftRequest, context: RpcCallContext): Promise<BeginDraftResponse>
  observeSql(request: ObserveSqlRequest, context: RpcCallContext): Promise<ObserveSqlResponse>
  addPrecondition(request: AddPreconditionRequest, context: RpcCallContext): Promise<DraftMutationResponse>
  addStatements(request: AddStatementsRequest, context: RpcCallContext): Promise<DraftMutationResponse>
  replaceStatements(request: ReplaceStatementsRequest, context: RpcCallContext): Promise<DraftMutationResponse>
  validateDraft(request: ValidateDraftRequest, context: RpcCallContext): Promise<ValidateDraftResponse>
  rebaseDraft(request: RebaseDraftRequest, context: RpcCallContext): Promise<RebaseDraftResponse>
  cancelDraft(request: CancelDraftRequest, context: RpcCallContext): Promise<CancelDraftResponse>
  publishDraft(request: PublishDraftRequest, context: RpcCallContext): Promise<PublishDraftResponse>
  getOutcome(request: GetOutcomeRequest, context: RpcCallContext): Promise<TransactionOutcome>
  getTransactionResult(request: GetTransactionResultRequest, context: RpcCallContext): Promise<GetTransactionResultResponse>
  streamOutcome(request: StreamOutcomeRequest, context: RpcCallContext): AsyncIterable<TransactionOutcome>
  getSettlementEvidence(request: GetSettlementEvidenceRequest, context: RpcCallContext): Promise<SettlementEvidence>
  streamSettlementEvidence(request: StreamSettlementEvidenceRequest, context: RpcCallContext): AsyncIterable<SettlementEvidence>
  getValidatorWatermark(request: GetValidatorWatermarkRequest, context: RpcCallContext): Promise<ValidatorWatermark>
  getReplicationStatus(request: GetReplicationStatusRequest, context: RpcCallContext): Promise<ReplicationStatus>
  streamReplicationStatus(request: StreamReplicationStatusRequest, context: RpcCallContext): AsyncIterable<ReplicationStatus>
}
export type ChronologService = ChronologRpcService
