import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  // The dev server binds 127.0.0.1; allow both loopback spellings for HMR.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
};

export default nextConfig;
