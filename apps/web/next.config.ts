import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The FalkorDB client opens TCP sockets; keep it out of the bundle and require it from
  // node_modules at runtime in the Node route handlers. It is also a direct dependency of the
  // app because Next only externalizes packages it can resolve from here; bundled, its Temporal
  // polyfill breaks (`BigInt is not a function`).
  serverExternalPackages: ['falkordb'],
  // @backtrack/core ships TypeScript sources with no build step, so Next compiles it with the app.
  transpilePackages: ['@backtrack/core'],
  reactStrictMode: true,
  experimental: {
    // Core uses Node ESM specifiers (`./types.js` for types.ts). Turbopack cannot map those back
    // to .ts (no extensionAlias support), so the app builds with webpack (`--webpack`) and this.
    extensionAlias: { '.js': ['.ts', '.tsx', '.js'] },
  },
};

export default nextConfig;
