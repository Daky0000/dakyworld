import { type Request, type Response } from "express";
import { SETTING, getSetting } from "../lib/settings.js";
import { GoogleError, consumeState, exchangeCode } from "../lib/google.js";
function origin(req: Request, configured: string | null): string {
    return (configured || `${req.protocol}://${req.get("host") ?? "localhost"}`).replace(/\/$/, "");
}
export async function handleGoogleCallback(req: Request, res: Response) {
    const appUrl = await getSetting(SETTING.APP_URL);
    const base = origin(req, appUrl);
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const pending = state ? consumeState(state) : null;
    const back = (params: Record<string, string>) => {
        const url = new URL(pending?.returnTo ?? "/settings", base);
        for (const [key, value] of Object.entries(params))
            url.searchParams.set(key, value);
        res.redirect(url.toString());
    };
    if (typeof req.query.error === "string")
        return back({ google: "error", message: req.query.error });
    if (!pending)
        return back({ google: "error", message: "That sign-in link had expired. Try again." });
    const code = typeof req.query.code === "string" ? req.query.code : "";
    if (!code)
        return back({ google: "error", message: "Google didn't return an authorisation code." });
    try {
        const { email } = await exchangeCode(code, base);
        back({ google: "connected", ...(email ? { account: email } : {}) });
    }
    catch (err) {
        back({ google: "error", message: err instanceof GoogleError ? err.message : "Could not complete the Google sign-in." });
    }
}
