# Lucid Slides

Lucid Slides is a browser-based PowerPoint clarity reviewer. It analyzes a local `.pptx`, shows meaning-based AI suggestions, and can create a new copy from explicitly approved, formatting-safe text changes.

## Safety status

The previous engine was unsafe. It truncated paragraphs, bolded opening words, rebuilt run-level formatting, removed images by dimensions, serialized every slide XML file, and treated ZIP creation as success. Those behaviors are disabled.

The repaired workflow:

1. Reads a selected `.pptx` locally with JSZip.
2. Validates required package parts and unsafe paths.
3. Extracts slide and element identifiers, exact text, and preservation inventories without serializing XML.
4. Shows local review findings with explicit “AI analysis required” placeholders.
5. Optionally sends only a reduced text-and-ID snapshot—not the PowerPoint file—to `/api/analyze`.
6. Shows validated proposals for individual approval or rejection.
7. Marks mixed-format, hyperlinked, field-generated, and manually line-broken paragraphs as manual-only.
8. Creates a new `.pptx` only after the user approves at least one safe proposal.
9. Revalidates approvals inside the writer and changes only an exact matching paragraph in an exact matching shape.

The original file is never modified. Untouched PowerPoint package parts, including media, relationships, notes, charts, and tables, are preserved. The writer refuses unapproved changes and paragraphs whose formatting cannot be preserved conservatively.

## Optional Groq analysis

`api/analyze.js` is a Vercel Function that keeps `GROQ_API_KEY` server-side, uses Groq structured output, and revalidates every proposal against an exact slide, object ID, and complete source paragraph. The default model is `openai/gpt-oss-120b` because the Llama models previously used by this branch were retired for free and developer accounts on August 16, 2026.

If `GROQ_API_KEY` is absent, the endpoint returns a clearly labeled `analysis-only` response and the browser continues with local findings. Never put an API key in frontend code or ask a user to paste one into the site.

Environment variables are documented in `.env.example`.

## Run locally

```bash
node local-server.js
```

Open `http://localhost:5173`. The local server is only for development; users access the deployed website normally.

## Tests

```bash
npm test
```

Run the full supplied-deck regression on this Mac with:

```bash
LUCID_TEST_PPTX="/Users/nathan/Desktop/slide for test.pptx" npm test
```

The real-deck regression confirms 22 slides are inspected and the source bytes remain unchanged. Writer tests also confirm that only approved uniform-format text is replaced while media, relationships, notes, charts, and hyperlinks remain byte-identical.

## Known platform limitation

Arbitrary PowerPoint editing remains intentionally unsupported. Lucid Slides does not resize objects, delete elements, change charts, alter animations, or rewrite mixed-format/hyperlinked paragraphs. Those cases are reported for manual PowerPoint review.
