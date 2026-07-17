import { generateVideoSitemapResponse } from '@/server/sitemaps/video';

export async function GET() {
  return generateVideoSitemapResponse();
}
