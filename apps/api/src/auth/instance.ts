import { hash, verify } from "argon2";
import { betterAuth } from "better-auth";
import { admin } from "better-auth/plugins";
import { getDb } from "../db.js";
import { configuredPublicUrl } from "../public-url.js";
import { authSecret } from "../secrets.js";

/* Snake_case throughout, because Postgres folds an unquoted identifier to
   lowercase and camelCase columns would need quoting for the rest of time. */
const USER_FIELDS = {
  emailVerified: "email_verified",
  createdAt: "created_at",
  updatedAt: "updated_at",
} as const;

const TIMESTAMPS = {
  expiresAt: "expires_at",
  createdAt: "created_at",
  updatedAt: "updated_at",
} as const;

// Five attempts a minute on the credential paths, which is what the hand-rolled
// limiter allowed. Better Auth's own default of 100 per 10s is far looser.
const SIGN_IN_LIMIT = { window: 60, max: 5 };

// Built through a function so the return type keeps the options Better Auth
// infers from this config; naming it erases them and the plugin routes with it.
function buildAuth() {
  return betterAuth({
    // The one handle Kysely already holds, so both write through one connection.
    database: { db: getDb(), type: "sqlite" },
    secret: authSecret(),
    ...(configuredPublicUrl() !== undefined && {
      baseURL: configuredPublicUrl(),
      trustedOrigins: [configuredPublicUrl() as string],
    }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      // OWASP's first recommendation, and the package's defaults already exceed
      // its floor at 64 MiB, 3 iterations and parallelism 4.
      password: {
        hash: (password) => hash(password),
        verify: ({ hash: stored, password }) => verify(stored, password),
      },
    },
    user: {
      fields: USER_FIELDS,
      /* Registration is open only until the owner exists. Gated on the method so
         an admin adding a colleague is not self-registration and passes. */
      validateUserInfo: async ({ source }) => {
        if (source.action !== "create-user") return;
        if (source.method !== "email-password") return;
        const owner = await getDb()
          .selectFrom("user")
          .select("id")
          .executeTakeFirst();
        if (owner) {
          return {
            error: "setup_already_complete",
            errorDescription: "This install already has an owner.",
          };
        }
      },
    },
    session: {
      // One letter from `sessions`, the agent's own, so it is renamed here.
      modelName: "auth_session",
      fields: {
        ...TIMESTAMPS,
        ipAddress: "ip_address",
        userAgent: "user_agent",
        userId: "user_id",
      },
    },
    account: {
      fields: {
        accountId: "account_id",
        providerId: "provider_id",
        userId: "user_id",
        accessToken: "access_token",
        refreshToken: "refresh_token",
        idToken: "id_token",
        accessTokenExpiresAt: "access_token_expires_at",
        refreshTokenExpiresAt: "refresh_token_expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    verification: { fields: TIMESTAMPS },
    databaseHooks: {
      user: {
        create: {
          // The plugin stamps every account 'user', so the install would have
          // no administrator without this.
          before: async (user) => {
            const owner = await getDb()
              .selectFrom("user")
              .select("id")
              .executeTakeFirst();
            return owner
              ? { data: user }
              : { data: { ...user, role: "admin" } };
          },
        },
      },
    },
    rateLimit: {
      // `enabled` is left to Better Auth, which runs the limiter in production
      // and not in development.
      customRules: {
        "/sign-in/email": SIGN_IN_LIMIT,
        "/change-password": SIGN_IN_LIMIT,
      },
    },
    plugins: [
      admin({
        schema: {
          user: {
            fields: { banReason: "ban_reason", banExpires: "ban_expires" },
          },
          session: { fields: { impersonatedBy: "impersonated_by" } },
        },
      }),
    ],
  });
}

type Auth = ReturnType<typeof buildAuth>;

let instance: Auth | null = null;

export function getAuth(): Auth {
  instance ??= buildAuth();
  return instance;
}

// Paired with resetDb: the instance holds the handle that one closes.
export function resetAuth(): void {
  instance = null;
}
