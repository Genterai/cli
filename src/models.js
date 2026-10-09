// Where every model call goes (chat and embeddings): Vercel AI Gateway when its token is given, else OpenRouter. Both take
// the same OpenAI-compatible body under the same model names (provider.sort, reasoning, usage.include) and report
// usage.cost, so only the address and the key differ.
export const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1";
export const OPENROUTER_URL = "https://openrouter.ai/api/v1";

// { url, key, name } of the provider to call, or null without a key.
export function modelApi({ aiGatewayToken, openrouterApiKey } = {}) {
  if (aiGatewayToken) return { url: GATEWAY_URL, key: aiGatewayToken, name: "AI Gateway" };
  if (openrouterApiKey) return { url: OPENROUTER_URL, key: openrouterApiKey, name: "OpenRouter" };
  return null;
}
