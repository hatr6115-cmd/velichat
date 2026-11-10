const defaultBaseUrl = "https://veilchat.onrender.com";
const baseUrl = (process.env.RENDER_APP_URL || process.env.APP_URL || defaultBaseUrl).trim();

function readPositiveInteger(name, fallback, minimum = 1) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) ? Math.max(minimum, value) : fallback;
}

const maxAttempts = Math.min(10, readPositiveInteger("KEEP_ALIVE_MAX_ATTEMPTS", 4));
const retryDelayMs = readPositiveInteger("KEEP_ALIVE_RETRY_DELAY_MS", 20_000, 0);
const requestTimeoutMs = readPositiveInteger("KEEP_ALIVE_TIMEOUT_MS", 60_000, 1_000);

let healthUrl;
try {
  const parsedBaseUrl = new URL(baseUrl);
  if (parsedBaseUrl.protocol !== "https:" && parsedBaseUrl.protocol !== "http:") {
    throw new Error("URL must use HTTP or HTTPS");
  }
  healthUrl = new URL("/api/health", parsedBaseUrl);
} catch (error) {
  console.error(`Invalid Render service URL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let succeeded = false;

for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  try {
    console.log(`Pinging ${healthUrl} (attempt ${attempt}/${maxAttempts})`);
    const response = await fetch(healthUrl, {
      method: "GET",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });

    await response.text();
    if (response.ok) {
      console.log(`Render is awake: health endpoint returned HTTP ${response.status}.`);
      succeeded = true;
      break;
    }

    console.warn(`Health endpoint returned HTTP ${response.status}.`);
  } catch (error) {
    console.warn(`Render health ping failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (attempt < maxAttempts) await wait(retryDelayMs);
}

if (!succeeded) {
  console.error(`Could not reach ${healthUrl} after ${maxAttempts} attempts.`);
  process.exit(1);
}
