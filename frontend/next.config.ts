import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

const frontendRoot = fileURLToPath(new URL(".", import.meta.url));

const nextConfig: NextConfig = {
  output: "standalone",
  turbopack: {
    root: frontendRoot,
  },
  allowedDevOrigins: ["127.0.0.1"],
  env: {
    NEXT_PUBLIC_PROD: process.env.NEXT_PUBLIC_PROD ?? process.env.PROD ?? "",
  },
  devIndicators: false,
};

export default nextConfig;
