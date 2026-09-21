// netlify/functions/egresos.mts
//
// Trae los datos de la planilla de Egresos a través de un Google Apps Script
// publicado como "Aplicación web" (ver instrucciones aparte). La planilla en
// sí sigue siendo privada: el script corre con la cuenta de Google del dueño
// de la planilla, y solo responde si recibe el token secreto correcto — el
// token nunca se expone al navegador, solo vive acá, del lado del servidor.
//
// Variables de entorno necesarias (Netlify → Site configuration → Environment variables):
//   EGRESOS_SCRIPT_URL    -> la URL que termina en /exec al implementar el Apps Script
//   EGRESOS_SCRIPT_TOKEN  -> el mismo valor que pusiste en SECRET dentro del script
//
// No requiere ninguna dependencia de npm nueva.

import { getStore } from "@netlify/blobs";

const CACHE_KEY = "egresos-ultima-copia";

export default async () => {
  const scriptUrl = process.env.EGRESOS_SCRIPT_URL;
  const token = process.env.EGRESOS_SCRIPT_TOKEN;
  const store = getStore("nap-dashboard");

  try {
    if (!scriptUrl || !token) {
      throw new Error("Faltan las variables EGRESOS_SCRIPT_URL / EGRESOS_SCRIPT_TOKEN");
    }

    const sep = scriptUrl.includes("?") ? "&" : "?";
    const url = scriptUrl + sep + "token=" + encodeURIComponent(token);

    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error("El Apps Script respondió " + res.status + ". " + text);
    }
    const payload = await res.json();
    if (payload && payload.error) {
      throw new Error("El Apps Script devolvió un error: " + payload.error);
    }

    // Guarda una copia de respaldo por si la próxima consulta falla.
    await store.setJSON(CACHE_KEY, payload);

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Egresos-Source": "sheets-live"
      }
    });
  } catch (err: any) {
    // Si falla la consulta en vivo, sirve la última copia buena conocida
    // en vez de romper el dashboard.
    const cached = await store.get(CACHE_KEY, { type: "json" }).catch(() => null);
    if (cached) {
      return new Response(JSON.stringify(cached), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "X-Egresos-Source": "cached-fallback",
          "X-Egresos-Error": String(err.message || err).slice(0, 200)
        }
      });
    }
    return new Response(JSON.stringify({ error: String(err.message || err) }), {
      status: 502,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
    });
  }
};
