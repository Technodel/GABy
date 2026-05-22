/**
 * @suny/sdk — Auth provider interface.
 * Custom authentication backends for SUNy instances.
 */

export interface AuthCredentials {
  username: string;
  password?: string;
  token?: string;
  metadata?: Record<string, unknown>;
}

export interface AuthSession {
  userId: number;
  username: string;
  role: 'user' | 'admin';
  displayName?: string;
  expiresAt?: string;
  token: string;
}

export interface AuthProvider {
  /** Authenticate a user with credentials */
  authenticate(credentials: AuthCredentials): Promise<AuthSession | null>;

  /** Validate an existing session token */
  validateToken(token: string): Promise<AuthSession | null>;

  /** Revoke a session */
  revoke(token: string): Promise<void>;

  /** Get provider metadata */
  getMetadata(): { name: string; version: string };
}

/**
 * Create a custom auth provider.
 */
export function createAuthProvider(provider: AuthProvider): AuthProvider {
  return provider;
}
