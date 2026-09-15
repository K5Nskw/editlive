import type {
  Analysis,
  AppConfig,
  BufferProfile,
  Clip,
  Highlight,
  Integrations,
  Publication,
  Recording,
  RenderSpec,
  Stream,
} from './types';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json', ...(init?.headers ?? {}) } : init?.headers,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : {};
  if (!res.ok) {
    const message =
      typeof body === 'object' && body !== null && 'error' in body
        ? String((body as { error: unknown }).error)
        : `リクエストに失敗しました (${res.status})`;
    throw new ApiError(res.status, message);
  }
  return body as T;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  config: () => request<AppConfig>('/api/config'),

  me: () => request<{ authenticated: boolean }>('/api/auth/me'),
  login: (password: string) => post<{ authenticated: boolean }>('/api/auth/login', { password }),
  logout: () => post<{ authenticated: boolean }>('/api/auth/logout'),

  streams: () => request<{ streams: Stream[] }>('/api/streams'),
  createStream: (name: string) => post<{ stream: Stream }>('/api/streams', { name }),
  updateStream: (id: string, patch: { name?: string; autoRecord?: boolean }) =>
    request<{ stream: Stream }>(`/api/streams/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  rotateKey: (id: string) => post<{ stream: Stream }>(`/api/streams/${id}/rotate-key`),
  deleteStream: (id: string) => request<void>(`/api/streams/${id}`, { method: 'DELETE' }),

  recordings: () => request<{ recordings: Recording[] }>('/api/recordings'),
  recording: (id: string) =>
    request<{ recording: Recording; highlights: Highlight[]; clips: Clip[] }>(`/api/recordings/${id}`),
  analysis: (id: string) => request<{ analysis: Analysis }>(`/api/recordings/${id}/analysis`),
  reanalyze: (id: string, sensitivity: number) => post<{ jobId: string }>(`/api/recordings/${id}/analyze`, { sensitivity }),
  renameRecording: (id: string, title: string) =>
    request<{ recording: Recording }>(`/api/recordings/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  deleteRecording: (id: string) => request<void>(`/api/recordings/${id}`, { method: 'DELETE' }),

  clips: (recordingId?: string) =>
    request<{ clips: Clip[] }>(`/api/clips${recordingId ? `?recordingId=${recordingId}` : ''}`),
  clip: (id: string) => request<{ clip: Clip; publications: Publication[] }>(`/api/clips/${id}`),
  createClip: (input: { recordingId: string; title: string; start: number; end: number; spec: RenderSpec }) =>
    post<{ clip: Clip }>('/api/clips', input),
  rerenderClip: (id: string) => post<{ clip: Clip }>(`/api/clips/${id}/rerender`),
  deleteClip: (id: string) => request<void>(`/api/clips/${id}`, { method: 'DELETE' }),
  publishClip: (id: string, target: string, options: Record<string, unknown>) =>
    post<{ publication: Publication }>(`/api/clips/${id}/publish`, { target, options }),

  integrations: () => request<Integrations>('/api/integrations'),
  youtubeAuthUrl: () => request<{ url: string }>('/api/integrations/youtube/auth-url'),
  youtubeDisconnect: () => post<{ ok: boolean }>('/api/integrations/youtube/disconnect'),
  saveBufferToken: (token: string) => post<{ ok: boolean }>('/api/integrations/buffer', { token }),
  clearBuffer: () => request<void>('/api/integrations/buffer', { method: 'DELETE' }),
  bufferProfiles: () => request<{ profiles: BufferProfile[] }>('/api/integrations/buffer/profiles'),
  saveWebhook: (url: string, secret?: string) => post<{ ok: boolean }>('/api/integrations/webhook', { url, secret }),
  clearWebhook: () => request<void>('/api/integrations/webhook', { method: 'DELETE' }),
};
