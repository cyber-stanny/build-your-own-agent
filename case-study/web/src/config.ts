const wsProtocol = window.location.protocol === "https:" ? "wss" : "ws";
const wsHost = import.meta.env.VITE_AGENT_WS_HOST ?? window.location.hostname;
const wsPort = import.meta.env.VITE_AGENT_WS_PORT ?? "8787";

export const webConfig = {
  wsUrl: import.meta.env.VITE_AGENT_WS_URL ?? `${wsProtocol}://${wsHost}:${wsPort}`,
} as const;
