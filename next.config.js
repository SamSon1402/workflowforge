/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Temporal SDK ships native add-ons; keep them external rather than
  // letting webpack try to bundle them.
  experimental: {
    serverComponentsExternalPackages: [
      '@temporalio/client',
      '@temporalio/worker',
      '@temporalio/workflow',
      '@temporalio/activity',
      '@prisma/client',
    ],
  },
};

module.exports = nextConfig;
