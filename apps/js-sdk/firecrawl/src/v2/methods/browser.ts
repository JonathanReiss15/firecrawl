import type {
  BrowserCreateResponse,
  BrowserExecuteResponse,
  BrowserDeleteResponse,
  BrowserListResponse,
  InteractRecipeOption,
} from "../types";
import { HttpClient } from "../utils/httpClient";
import {
  normalizeAxiosError,
  throwForBadResponse,
} from "../utils/errorHandler";

export async function browser(
  http: HttpClient,
  args: {
    /**
     * Optional starting URL. The freshly created session is navigated here
     * before the response returns. Private/internal-network targets are
     * rejected by the API.
     */
    url?: string;
    /**
     * Optional initial execution: `prompt` OR `code` (never both) runs against
     * the freshly created (and, if `url` given, navigated) session in the same
     * request; the session stays alive afterwards.
     */
    code?: string;
    prompt?: string;
    language?: "python" | "node" | "bash";
    /** Timeout for the initial execution, in seconds. */
    timeout?: number;
    ttl?: number;
    activityTtl?: number;
    streamWebView?: boolean;
    recordSession?: boolean;
    profile?: {
      name: string;
      saveChanges?: boolean;
    };
    integration?: string;
    origin?: string;
    /**
     * Recipe behavior for the initial execution: learn a reusable recipe from
     * `prompt`, or execute a previously learned, pinned recipe.
     */
    recipe?: InteractRecipeOption;
  } = {},
): Promise<BrowserCreateResponse> {
  if (args.code && args.prompt) {
    throw new Error("Provide exactly one of 'prompt' or 'code', not both");
  }
  if (args.recipe && args.code) {
    throw new Error("'recipe' cannot be combined with 'code'");
  }
  if (args.recipe && "mode" in args.recipe && !args.prompt) {
    throw new Error("recipe mode 'learn' requires a 'prompt'");
  }

  const body: Record<string, unknown> = {};
  if (args.url) body.url = args.url;
  if (args.code) body.code = args.code;
  if (args.prompt) body.prompt = args.prompt;
  if (args.language != null) body.language = args.language;
  if (args.timeout != null) body.timeout = args.timeout;
  if (args.ttl != null) body.ttl = args.ttl;
  if (args.activityTtl != null) body.activityTtl = args.activityTtl;
  if (args.streamWebView != null) body.streamWebView = args.streamWebView;
  if (args.recordSession != null) body.recordSession = args.recordSession;
  if (args.profile != null) body.profile = args.profile;
  if (args.integration != null) body.integration = args.integration;
  if (args.origin) body.origin = args.origin;
  if (args.recipe) body.recipe = args.recipe;

  try {
    const res = await http.post<BrowserCreateResponse>(
      "/v2/browser",
      body,
      args.timeout != null ? { timeoutMs: args.timeout * 1000 + 30000 } : {},
    );
    if (res.status !== 200) throwForBadResponse(res, "create browser session");
    return res.data;
  } catch (err: any) {
    if (err?.isAxiosError)
      return normalizeAxiosError(err, "create browser session");
    throw err;
  }
}

export async function browserExecute(
  http: HttpClient,
  sessionId: string,
  args: {
    code?: string;
    prompt?: string;
    language?: "python" | "node" | "bash";
    timeout?: number;
    /**
     * Learn a reusable recipe from `prompt`, or execute a pinned recipe. A
     * pinned execution needs neither `prompt` nor `code`.
     */
    recipe?: InteractRecipeOption;
  },
): Promise<BrowserExecuteResponse> {
  const isPinnedRecipe = !!args.recipe && "recipeId" in args.recipe;
  if (!args.code && !args.prompt && !isPinnedRecipe) {
    throw new Error("Either 'code' or 'prompt' must be provided");
  }
  if (args.code && args.prompt) {
    throw new Error("Provide exactly one of 'prompt' or 'code', not both");
  }
  if (args.recipe && args.code) {
    throw new Error("'recipe' cannot be combined with 'code'");
  }
  if (args.recipe && !isPinnedRecipe && !args.prompt) {
    throw new Error("recipe mode 'learn' requires a 'prompt'");
  }

  const body: Record<string, unknown> = {};
  if (args.code) {
    body.code = args.code;
    body.language = args.language ?? "bash";
  }
  if (args.prompt) body.prompt = args.prompt;
  if (args.timeout != null) body.timeout = args.timeout;
  if (args.recipe) body.recipe = args.recipe;

  try {
    const res = await http.post<BrowserExecuteResponse>(
      `/v2/browser/${sessionId}/execute`,
      body,
      args.timeout != null ? { timeoutMs: args.timeout * 1000 + 5000 } : {},
    );
    if (res.status !== 200) throwForBadResponse(res, "execute browser code");
    return res.data;
  } catch (err: any) {
    if (err?.isAxiosError)
      return normalizeAxiosError(err, "execute browser code");
    throw err;
  }
}

export async function deleteBrowser(
  http: HttpClient,
  sessionId: string,
): Promise<BrowserDeleteResponse> {
  try {
    const res = await http.delete<BrowserDeleteResponse>(
      `/v2/browser/${sessionId}`,
    );
    if (res.status !== 200) throwForBadResponse(res, "delete browser session");
    return res.data;
  } catch (err: any) {
    if (err?.isAxiosError)
      return normalizeAxiosError(err, "delete browser session");
    throw err;
  }
}

export async function listBrowsers(
  http: HttpClient,
  args: {
    status?: "active" | "destroyed";
  } = {},
): Promise<BrowserListResponse> {
  let endpoint = "/v2/browser";
  if (args.status) endpoint += `?status=${args.status}`;

  try {
    const res = await http.get<BrowserListResponse>(endpoint);
    if (res.status !== 200) throwForBadResponse(res, "list browser sessions");
    return res.data;
  } catch (err: any) {
    if (err?.isAxiosError)
      return normalizeAxiosError(err, "list browser sessions");
    throw err;
  }
}
