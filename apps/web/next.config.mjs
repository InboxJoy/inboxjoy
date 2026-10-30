/** @type {import('next').NextConfig} */
const nextConfig = {
  agentRules: false,
  transpilePackages: ["@inboxjoy/db", "@inboxjoy/ui"]
};

export default nextConfig;
