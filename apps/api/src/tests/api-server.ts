import type { FastifyInstance } from "fastify";

type Registrar = (instance: FastifyInstance) => Promise<void>;

// Mounts under /api as index.ts does, so seam tests drive the real URLs.
export async function mountApi(
  server: FastifyInstance,
  ...registrars: Registrar[]
): Promise<void> {
  await server.register(
    async (api) => {
      for (const register of registrars) await register(api);
    },
    { prefix: "/api" },
  );
}
