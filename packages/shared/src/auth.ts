export type AuthStatusResponse =
  | { ownerExists: false }
  | { ownerExists: true; authenticated: false }
  | { ownerExists: true; authenticated: true; email: string };
