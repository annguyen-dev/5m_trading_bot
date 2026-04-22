/**
 * Voyage AI embedding via direct REST API.
 * The voyageai npm package v0.2.1 has a broken ESM build (references .jsx files that don't exist).
 * Direct API call is simpler and avoids the dependency entirely.
 */

import axios from 'axios';

const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings';

interface VoyageResponse {
  data: { embedding: number[] }[];
}

export async function voyageEmbed(
  texts: string[],
  apiKey: string,
  model = 'voyage-3',
): Promise<number[][]> {
  const resp = await axios.post<VoyageResponse>(
    VOYAGE_API_URL,
    { model, input: texts },
    { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } },
  );
  return resp.data.data.map(d => d.embedding);
}
