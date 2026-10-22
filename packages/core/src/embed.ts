import { pipeline } from "@huggingface/transformers";

/** all-MiniLM-L6-v2, 384 dims, CPU. Songs and mood descriptions share this space. */
type Embedder = (
  input: string[],
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ data: Float32Array; dims: number[] }>;

let model: Promise<Embedder> | undefined;
const load = () =>
  (model ??= pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
    dtype: "fp32",
  }) as unknown as Promise<Embedder>);

export async function embedTexts(texts: string[]): Promise<number[][]> {
  const embed = await load();
  const out = await embed(texts, { pooling: "mean", normalize: true });
  const dims = out.dims[1] as number;
  return texts.map((_, i) => Array.from(out.data.slice(i * dims, (i + 1) * dims)));
}

export const embedText = async (text: string): Promise<number[]> =>
  (await embedTexts([text]))[0] ?? [];
