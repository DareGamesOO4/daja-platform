export function allowedCorsOrigins(origins: string[], environment: string): string[] {
  return [
    ...new Set([...origins, 'capacitor://localhost', 'http://localhost', 'https://localhost'])
  ].filter(
    (origin) =>
      origin !== '*' &&
      origin !== 'null' &&
      (!['production', 'staging'].includes(environment) || !/^https?:\/\/(?:localhost|127\.0\.0\.1):\d+$/.test(origin))
  );
}

export function allowedRealtimeOrigin(origin: string | undefined): boolean {
  // Native clients may omit Origin. Their bearer token is still mandatory.
  return (
    !origin ||
    allowedCorsOrigins(
      (process.env.CORS_ALLOWED_ORIGINS || '')
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean),
      process.env.NODE_ENV || 'production'
    ).includes(origin)
  );
}
