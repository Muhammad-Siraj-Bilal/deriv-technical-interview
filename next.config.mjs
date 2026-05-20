/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingIncludes: {
    "/*": ["./tickets.json", "./policy.json"],
  },
};

export default nextConfig;
