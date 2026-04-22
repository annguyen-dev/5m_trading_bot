export interface NewsEvent {
  id: string;
  headline: string;
  url: string;
  source: string;
  sentiment: number;   // [-1, 1]  negative → positive
  publishedAt: number; // Unix ms
}
