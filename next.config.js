/** @type {import('next').NextConfig} */
const nextConfig = {
  // pdf-parse + mammoth are pure-node deps used inside server actions
  // (uploadTrainingFile in voice/actions.ts). Keep them out of the
  // bundle so Next doesn't try to ship them client-side.
  serverExternalPackages: ['pdf-parse', 'mammoth'],
  experimental: {
    serverActions: {
      bodySizeLimit: '4mb',
    },
  },
  async redirects() {
    return [
      // Phase 14b — unified Garden absorbs old Insights surface.
      // /studio/ideas/[id] → /studio/garden/[id]
      {
        source: '/studio/ideas/:id',
        destination: '/studio/garden/:id',
        permanent: true,
      },
      // /studio/ideas → /studio/garden
      {
        source: '/studio/ideas',
        destination: '/studio/garden',
        permanent: true,
      },
      // /studio/insights → /studio/garden
      {
        source: '/studio/insights',
        destination: '/studio/garden',
        permanent: true,
      },
    ];
  },
};

module.exports = nextConfig;
