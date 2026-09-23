import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The poll route does its real work inside after(), which keeps the function
  // alive past the response. Nothing here should force the Edge runtime: the
  // MongoDB driver is Node-only.
  serverExternalPackages: ["mongodb"],
};

export default nextConfig;
