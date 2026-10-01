import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  cacheComponents: true,
  partialPrefetching: true,
  // Clients became companies with a client relationship.
  async redirects() {
    return [
      {
        source: "/clients",
        destination: "/companies?relationship=client",
        permanent: true,
      },
    ];
  },
};

export default withWorkflow(nextConfig);
