import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// The Dropbox URL is stored in the DROPBOX_SQLITE_URL environment variable
// (Netlify project settings), not hardcoded here.
function dropboxDirectUrl(): string {
  const raw = Netlify.env.get("DROPBOX_SQLITE_URL") || "";
  // Force Dropbox to serve raw bytes instead of the HTML preview page.
  return raw.replace("dl=0", "dl=1");
}

const SQLITE_MAGIC = "SQLite format 3\u0000";

function looksLikeSqlite(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 16) return false;
  const head = new TextDecoder("latin1").decode(new Uint8Array(buf, 0, 16));
  return head === SQLITE_MAGIC;
}

export default async (req: Request, _context: Context) => {
  const store = getStore("nap-db");
  const url = dropboxDirectUrl();

  if (!url) {
    return new Response("DROPBOX_SQLITE_URL no está configurada en el sitio de Netlify.", { status: 500 });
  }

  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`Dropbox respondió ${res.status}`);
    const buf = await res.arrayBuffer();

    if (!looksLikeSqlite(buf)) {
      throw new Error("El archivo descargado no es un SQLite válido (posible archivo a medio sincronizar).");
    }

    // Cache the last good copy so a bad/slow Dropbox fetch never breaks the dashboard.
    await store.set("latest.sqlite", buf);

    return new Response(buf, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "public, max-age=300",
        "X-DB-Source": "dropbox-live",
      },
    });
  } catch (err) {
    const fallback = await store.get("latest.sqlite", { type: "arrayBuffer" });
    if (fallback) {
      return new Response(fallback, {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Cache-Control": "public, max-age=60",
          "X-DB-Source": "cached-fallback",
          "X-DB-Error": String((err as Error).message || err).slice(0, 200),
        },
      });
    }
    return new Response(
      `No se pudo obtener la base de datos de Dropbox y no hay copia en caché. Detalle: ${(err as Error).message || err}`,
      { status: 502 }
    );
  }
};

export const config: Config = {
  path: "/api/db",
};
