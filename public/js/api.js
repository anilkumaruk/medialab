export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data || {};
  }
}

export async function api(path, { method, body } = {}) {
  const res = await fetch('/api' + path, {
    method: method || (body !== undefined ? 'POST' : 'GET'),
    credentials: 'same-origin',
    headers: {
      'X-Requested-With': 'medialab',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : null;
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth')) window.dispatchEvent(new Event('ml:unauthorized'));
    throw new ApiError(data?.error || `Request failed (${res.status})`, res.status, data);
  }
  return data;
}
