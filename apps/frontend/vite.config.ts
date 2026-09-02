import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { brotliCompress } from "node:zlib";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import license from "rollup-plugin-license";
import { defineConfig, type Plugin } from "vite";

const compress = promisify(brotliCompress);

// Brotli at build time rather than per request: the API serves the .br beside
// each file, so a megabyte of JS ships a quarter the size at no runtime cost.
function precompress(): Plugin {
  const text = /\.(?:js|css|html|svg|json)$/;
  return {
    name: "nightwarden:precompress",
    apply: "build",
    async closeBundle() {
      const outDir = fileURLToPath(new URL("./dist", import.meta.url));
      const entries = await readdir(outDir, { recursive: true });
      await Promise.all(
        entries
          .filter((entry) => text.test(entry))
          .map(async (entry) => {
            const file = join(outDir, entry);
            const raw = await readFile(file);
            if (raw.byteLength < 1024) return;
            await writeFile(`${file}.br`, await compress(raw));
          }),
      );
    },
  };
}

export default defineConfig({
  plugins: [tailwindcss(), react(), precompress()],
  build: {
    rollupOptions: {
      // Vite inlines these packages into the bundle, so unlike an installed
      // dependency their licences reach the image only if written out here.
      plugins: [
        license({
          thirdParty: {
            includePrivate: false,
            output: {
              file: fileURLToPath(
                new URL("./dist/THIRD-PARTY-LICENSES.txt", import.meta.url),
              ),
            },
          },
        }),
      ],
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // Forwarded verbatim: the API serves these routes under /api itself, so dev
    // and production URLs are identical and neither can drift from the other.
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
