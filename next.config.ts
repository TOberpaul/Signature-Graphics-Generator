import type { NextConfig } from "next";

/**
 * GitHub Pages serves a project repository from a sub path
 * (`/<repo>/`), not from the domain root. The base path has to match that or
 * every asset request 404s. It is only applied in the Pages build, so local
 * development keeps serving from `/`.
 */
const isPagesBuild = process.env.GITHUB_PAGES === "true";
const repository = "Signature-Graphics-Generator";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Everything runs in the browser - the conversion, the preview and the export -
  // so the app is a static site and needs no server at all.
  output: "export",
  ...(isPagesBuild
    ? { basePath: `/${repository}`, assetPrefix: `/${repository}/` }
    : {}),
  // Keep the build scoped to this folder instead of walking up to the home dir.
  turbopack: {
    root: import.meta.dirname,
  },
};

export default nextConfig;
