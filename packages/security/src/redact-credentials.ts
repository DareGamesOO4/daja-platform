const credentialKey =
  /^(?:password(?:hash)?|password_hash|currentPassword|newPassword|confirmPassword|pin|otp|accessToken|refreshToken|access_token|refresh_token|secret|clientSecret|apiKey)$/i;

/** Remove credentials before persisting or returning an audit/sync payload. */
export function redactCredentials<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item: unknown) => redactCredentials(item)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !credentialKey.test(key))
        .map(([key, item]) => [key, redactCredentials(item)])
    ) as T;
  }
  return value;
}
