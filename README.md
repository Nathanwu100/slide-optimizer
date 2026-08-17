# Lucid Slides

Lucid Slides is a browser-based presentation optimizer designed for ADHD and distracted audiences. Consumers connect Google Drive, select a native Google Slides presentation, and receive a separate optimized Google Slides copy. There is no PowerPoint, PDF, download, conversion, extension, or local-file workflow.

## Consumer flow

1. Click **Connect Google Drive**.
2. Grant the narrow `https://www.googleapis.com/auth/drive.file` permission.
3. Select one native Google Slides presentation in Google Picker.
4. Lucid Slides duplicates it with Drive `files.copy`.
5. Lucid Slides edits only the copy through the Google Slides API.
6. Open the returned Google Slides link.

The browser sends a reduced slide structure and short-lived Google-rendered slide preview URLs to `/api/optimize`. Google access tokens stay in the browser and are never sent to the Lucid Slides backend. The OpenAI key stays in the server environment and is never returned to the browser.

## Deploy to Vercel

The application is a static frontend plus three Vercel Functions. There is no build step and no runtime software for consumers to install.

1. Import this GitHub repository into Vercel.
2. In Google Cloud, enable:
   - Google Drive API
   - Google Slides API
   - Google Picker API
3. Configure the Google OAuth consent screen with only `https://www.googleapis.com/auth/drive.file`.
4. Create a **Web application** OAuth client. Add the Vercel production URL and any custom domain under **Authorized JavaScript origins**.
5. Create a browser API key. Restrict it to the production HTTP referrer and Google Picker API.
6. Find the numeric Google Cloud project number; this is the Picker App ID.
7. Add the variables from `.env.example` in Vercel Project Settings → Environment Variables.
8. Deploy. Add the final production origin to `ALLOWED_ORIGIN` and to the OAuth client's authorized JavaScript origins.

`GOOGLE_CLIENT_ID`, `GOOGLE_API_KEY`, and `GOOGLE_APP_ID` are public browser identifiers and are returned by `/api/config`. Restrict the API key by referrer and API. `OPENAI_API_KEY` is server-only.

## Optimization rules

| Rule | Implementation |
| --- | --- |
| 1–2 | The backend identifies the takeaway and returns a validated title rewrite of at most 10 words. |
| 3 | Browser-side structural logic shortens non-title text blocks to at most 12 words. |
| 4 | Browser-side structural logic clears excess bolding and bolds only the opening focus phrase. |
| 5 | The backend selects an exact existing phrase; the browser enlarges and bolds it. |
| 6 | The backend may add context to an exact existing statistic without inventing facts; the browser enlarges it. |
| 7 | Unsupported: the Google Slides API does not expose progressive bullet reveals. Reported for manual review. |
| 8 | Lucid Slides can add or rewrite a conclusion headline. Internal chart-series styling is not changed because that requires broader Google Sheets access. |
| 9 | The backend may identify decorative empty-text elements; the browser revalidates their types before deletion. |
| 10 | The backend may group more than two ideas; the browser duplicates the slide and retains the relevant elements in each copy. |
| 11 | Unsupported: the Google Slides API does not expose appear/fade animation authoring. Reported for manual review. |
| 12 | The backend performs a structured clarity check and flags slides that still need human review. |

## Security and privacy

- OAuth requests only `drive.file`, not broad Drive access.
- The selected presentation is duplicated before any Slides API update.
- Google access tokens never reach the backend.
- OpenAI requests set `store: false`, use Structured Outputs, and use low-detail rendered previews for visual judgment. Preview URLs are allowlisted to Google-owned HTTPS hosts.
- The backend validates body size, slide count, element IDs, returned object IDs, text ranges, removal types, and split groups.
- Same-origin request headers, an optional `ALLOWED_ORIGIN` allowlist, security headers, and a basic per-instance rate limit are included.
- For substantial public traffic, add durable distributed rate limiting and abuse controls before offering free credits.

## Development checks

```bash
npm test
```

For local OAuth testing, use a local Vercel development server and add its origin to the Google OAuth client's authorized JavaScript origins. Local tooling is for developers only; consumers use the deployed website entirely in their browser.
