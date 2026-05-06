/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,
  experimental: { serverActions: { bodySizeLimit: "2mb" } },
};
