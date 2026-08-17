function send(res, status, body) {
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json(body);
}

export default function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return send(res, 405, { error: "Method not allowed." });
  }

  const googleClientId = process.env.GOOGLE_CLIENT_ID || "";
  const googleApiKey = process.env.GOOGLE_API_KEY || "";
  const googleAppId = process.env.GOOGLE_APP_ID || "";
  if (!googleClientId || !googleApiKey || !googleAppId) {
    return send(res, 503, { error: "Google OAuth and Picker environment variables are not configured." });
  }

  return send(res, 200, { googleClientId, googleApiKey, googleAppId });
}
