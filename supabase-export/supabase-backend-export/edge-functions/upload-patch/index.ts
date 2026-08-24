/**
 * upload-patch — receives a ZIP body, stores it in the patch-uploads bucket,
 * and returns a 24-hour signed URL (temporary public download link).
 *
 * POST /functions/v1/upload-patch
 *   Headers: Content-Type: application/zip
 *            X-Filename: <name>.zip   (optional, defaults to upload.zip)
 *   Body:    raw ZIP bytes
 *
 * Response: { "url": "https://..." }
 */
import { createClient } from "npm:@supabase/supabase-js@2";

const BUCKET = "patch-uploads";
const TTL_SECONDS = 60 * 60 * 24; // 24 hours

Deno.serve(async (req: Request) => {
  // ── CORS preflight ────────────────────────────────────────────────────────
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Filename",
      },
    });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Accept raw bytes from the body
    const arrayBuffer = await req.arrayBuffer();
    if (!arrayBuffer.byteLength) {
      return json({ error: "Empty body" }, 400);
    }

    const filename = req.headers.get("X-Filename") || "upload.zip";
    // Prefix with timestamp to avoid collisions
    const path = `${Date.now()}_${filename}`;

    // ── Upload to Storage ───────────────────────────────────────────────────
    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(path, arrayBuffer, {
        contentType: "application/zip",
        upsert: false,
      });

    if (uploadError) {
      return json({ error: uploadError.message }, 500);
    }

    // ── Generate signed URL (24 h) ──────────────────────────────────────────
    const { data: signedData, error: signedError } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(path, TTL_SECONDS);

    if (signedError || !signedData?.signedUrl) {
      return json({ error: signedError?.message ?? "Failed to create signed URL" }, 500);
    }

    return json({ url: signedData.signedUrl, expiresIn: "24 hours", filename });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: msg }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
