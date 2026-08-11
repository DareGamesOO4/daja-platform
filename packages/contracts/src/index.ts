export interface ApiEnvelope<TData, TMeta extends Record<string, unknown> = Record<string, never>> {
  data: TData;
  meta: TMeta;
  requestId: string;
}

export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    details: Record<string, unknown>;
    requestId: string;
  };
}
