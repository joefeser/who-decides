import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // The engine writes only to .tmp/ — no build-time secrets, no external calls.
}

export default nextConfig
